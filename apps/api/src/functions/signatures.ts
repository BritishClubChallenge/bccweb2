// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import type { Round, RoundBrief } from "@bccweb/types";
import { BriefSchema, RoundSchema } from "@bccweb/schemas";
import { getPrivateBlobClient } from "../lib/blob.js";
import { readJson } from "../lib/blobJson.js";
import { getCallerIdentity, unauthorizedResponse } from "../lib/auth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";
import { getActiveWording } from "../lib/signTofly/wording.js";
import { computeBriefHash } from "../lib/signTofly/briefVersion.js";
import {
  buildSignaturePayload,
  listSignaturesForRound,
  overrideSignaturePath,
  readSignature,
  signaturePath,
  writeSignature,
  writeSignatureToPath,
} from "../lib/signTofly/ledger.js";
import { appendAuditLine } from "../lib/signTofly/auditLog.js";
import { reflectRoundSignToFly } from "../lib/signTofly/reflect.js";
import { enqueueSignToFlyReflect } from "../lib/queue.js";
import { getTelemetryClient } from "../lib/telemetry.js";
import { redactObject } from "../lib/telemetryRedactor.js";

type RoundBriefWithVersion = RoundBrief & { version?: number };

async function queueReflect(roundId: string): Promise<void> {
  try {
    await enqueueSignToFlyReflect({ roundId });
  } catch (err: unknown) {
    getTelemetryClient()?.trackEvent({
      name: "signToFly.enqueueFailed",
      properties: redactObject({ roundId, error: String(err) }) as Record<string, unknown>,
    });
  }
}

async function signOwnSlot(
  req: HttpRequest,
  _ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();

  const { roundId, teamId, place } = req.params as {
    roundId?: string;
    teamId?: string;
    place?: string;
  };
  if (!roundId || !teamId || !place) {
    throw new HttpError(400, "MISSING_IDS", "Missing round, team, or place");
  }
  const placeNum = Number(place);
  if (!Number.isInteger(placeNum)) {
    throw new HttpError(400, "INVALID_PLACE", "place must be a number");
  }

  const round = await readRound(roundId);
  const slot = findSlot(round, teamId, placeNum);
  // Authorised by slot OWNERSHIP, not role. A caller may self-sign only their
  // own slot; an Admin/RoundsCoord signing ANOTHER pilot's slot must use the
  // override endpoint. Signing one's OWN slot is a normal self-sign even for an
  // Admin/Coord who also holds a Pilot profile — so this role gate lives inside
  // the not-owned branch, never before the ownership check.
  if (!caller.pilotId || slot?.pilotId !== caller.pilotId) {
    if (caller.roles.includes("Admin") || caller.roles.includes("RoundsCoord")) {
      throw new HttpError(403, "NOT_YOUR_SLOT_USE_OVERRIDE");
    }
    throw new HttpError(403, "NOT_YOUR_SLOT");
  }
  if (round.status !== "BriefComplete") {
    throw new HttpError(409, "INVALID_STATE", `Round status is ${round.status}`);
  }
  if (slot.status !== "Filled") {
    throw new HttpError(409, "SLOT_EMPTY");
  }

  const [wording, brief] = await Promise.all([
    getActiveWording(),
    requireFrozenBrief(roundId),
  ]);
  const briefVersion = brief.version ?? 1;
  const existing = await readSignature(roundId, teamId, placeNum, caller.pilotId, briefVersion);
  if (existing) {
    await queueReflect(roundId);
    return { status: 200, jsonBody: existing };
  }

  const sig = buildSignaturePayload({
    id: randomUUID(),
    roundId,
    teamId,
    place: placeNum,
    pilotId: caller.pilotId,
    userId: caller.userId,
    signedAt: new Date().toISOString(),
    brief,
    wording,
    req,
    source: "pilot-self",
  });

  await writeSignature(sig);
  await queueReflect(roundId);
  return { status: 201, jsonBody: sig };
}

async function overrideSlotSignature(
  req: HttpRequest,
  _ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();

  const { roundId, teamId, place } = req.params as {
    roundId?: string;
    teamId?: string;
    place?: string;
  };
  if (!roundId || !teamId || !place) {
    throw new HttpError(400, "MISSING_IDS", "Missing round, team, or place");
  }
  const placeNum = Number(place);
  if (!Number.isInteger(placeNum)) {
    throw new HttpError(400, "INVALID_PLACE", "place must be a number");
  }

  const body = await req.json() as { reason?: unknown; onBehalfOfPilotId?: unknown };
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 20) {
    throw new HttpError(400, "INVALID_REASON", "Reason must be at least 20 characters");
  }
  const onBehalfOfPilotId = typeof body.onBehalfOfPilotId === "string"
    ? body.onBehalfOfPilotId
    : "";

  const round = await readRound(roundId);
  const isAdmin = caller.roles.includes("Admin");
  const isScopedCoord = caller.roles.includes("RoundsCoord") &&
    caller.clubId !== null &&
    round.organisingClub?.id === caller.clubId;
  if (!isAdmin && !isScopedCoord) {
    throw new HttpError(403, "FORBIDDEN");
  }

  const slot = findSlot(round, teamId, placeNum);
  if (!slot) throw new HttpError(404, "NOT_FOUND", "Pilot slot not found");
  if (slot.pilotId !== onBehalfOfPilotId) {
    throw new HttpError(400, "PILOT_MISMATCH", "onBehalfOfPilotId does not match the slot's assigned pilot");
  }
  if (round.status !== "BriefComplete") {
    throw new HttpError(409, "INVALID_STATE", `Round status is ${round.status}`);
  }
  if (slot.status !== "Filled") {
    throw new HttpError(409, "SLOT_EMPTY");
  }

  const [wording, brief] = await Promise.all([
    getActiveWording(),
    requireFrozenBrief(roundId),
  ]);
  const briefVersion = brief.version ?? 1;
  const existing = await readSignature(roundId, teamId, placeNum, onBehalfOfPilotId, briefVersion);
  const sig = buildSignaturePayload({
    id: randomUUID(),
    roundId,
    teamId,
    place: placeNum,
    pilotId: onBehalfOfPilotId,
    userId: caller.userId,
    signedAt: new Date().toISOString(),
    brief,
    wording,
    req,
    source: "coord-override",
    overrideBy: caller.userId,
    overrideReason: reason,
  });

  const path = overrideSignaturePath(roundId, teamId, placeNum, onBehalfOfPilotId, briefVersion, randomUUID().slice(0, 8));
  await writeSignatureToPath(sig, path);
  await appendAuditLine("sign-override", {
    ...sig,
    audit: {
      whenAdded: sig.signedAt,
      signaturePath: path,
      originalSignaturePathIfAny: existing
        ? signaturePath(roundId, teamId, placeNum, onBehalfOfPilotId, briefVersion)
        : null,
      originalSignatureSourceIfAny: existing?.source ?? null,
      pilotAndCoordSigned: Boolean(existing && existing.source !== "coord-override"),
    },
  });
  await queueReflect(roundId);

  return { status: 201, jsonBody: sig };
}

async function getRoundSignatures(
  req: HttpRequest,
  _ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();

  const roundId = req.params["roundId"];
  if (!roundId) throw new HttpError(400, "MISSING_ROUND_ID", "Missing round id");

  const round = await readRound(roundId);
  const isAdmin = caller.roles.includes("Admin");
  const isScopedCoord = caller.roles.includes("RoundsCoord") &&
    caller.clubId !== null &&
    round.organisingClub?.id === caller.clubId;
  if (!isAdmin && !isScopedCoord) {
    throw new HttpError(403, "FORBIDDEN");
  }

  const signatures = await listSignaturesForRound(roundId);
  signatures.sort((a, b) =>
    a.teamId.localeCompare(b.teamId) ||
    a.place - b.place ||
    ((a.briefVersion ?? 0) - (b.briefVersion ?? 0)),
  );
  return { status: 200, jsonBody: signatures };
}

async function reflectSignToFly(
  req: HttpRequest,
  _ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();

  const roundId = req.params["roundId"];
  if (!roundId) throw new HttpError(400, "MISSING_ROUND_ID");

  const round = await readRound(roundId);
  const isAdmin = caller.roles.includes("Admin");
  const isScopedCoord = caller.roles.includes("RoundsCoord") &&
    caller.clubId !== null &&
    round.organisingClub?.id === caller.clubId;
  if (!isAdmin && !isScopedCoord) {
    throw new HttpError(403, "FORBIDDEN");
  }

  if (round.status !== "BriefComplete") {
    throw new HttpError(409, "INVALID_STATE", `Round status is ${round.status}`);
  }

  await reflectRoundSignToFly(roundId);
  const updated = await readRound(roundId);
  return { status: 200, jsonBody: updated };
}

async function readRound(roundId: string): Promise<Round> {
  const path = `rounds/${roundId}.json`;
  try {
    return await readJson(getPrivateBlobClient(path), RoundSchema, path);
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Round not found");
    }
    throw err;
  }
}

async function readBriefOrNull(roundId: string): Promise<RoundBriefWithVersion | null> {
  const path = `round-briefs/${roundId}.json`;
  try {
    return await readJson(getPrivateBlobClient(path), BriefSchema, path);
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) return null;
    throw err;
  }
}

// G2: a signature may only attach to a FROZEN, untampered brief — a missing or
// hash-less brief is BRIEF_REQUIRED (no lazy-create on the signing path), and a
// `hash` that no longer matches the material content is rejected.
async function requireFrozenBrief(roundId: string): Promise<RoundBriefWithVersion> {
  const brief = await readBriefOrNull(roundId);
  if (!brief || !brief.hash) {
    throw new HttpError(409, "BRIEF_REQUIRED", "Round brief must be finalised before signing");
  }
  if (computeBriefHash(brief) !== brief.hash) {
    throw new HttpError(409, "BRIEF_HASH_MISMATCH", "Round brief changed since it was finalised");
  }
  return brief;
}

function findSlot(round: Round, teamId: string, place: number) {
  const team = round.teams.find((candidate) => candidate.id === teamId);
  return team?.pilots.find((slot) => slot.placeInTeam === place) ?? null;
}

app.http("signOwnSlot", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{roundId}/teams/{teamId}/pilots/{place}/sign",
  handler: withErrorHandler(signOwnSlot),
});

app.http("getRoundSignatures", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "rounds/{roundId}/signatures",
  handler: withErrorHandler(getRoundSignatures),
});

app.http("overrideSlotSignature", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{roundId}/teams/{teamId}/pilots/{place}/sign-override",
  handler: withErrorHandler(overrideSlotSignature),
});

app.http("reflectSignToFly", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{roundId}/reflect-sign-to-fly",
  handler: withErrorHandler(reflectSignToFly),
});
