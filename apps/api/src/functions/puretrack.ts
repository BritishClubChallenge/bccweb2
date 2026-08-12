// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * PureTrack endpoints — Phase 4
 *
 * POST /api/rounds/{id}/puretrack/create-groups
 *   Manually (re-)creates PureTrack groups for a locked round.
 *   Auth: RoundsCoord or Admin only.
 *
 * GET /api/manage/puretrack/groups?roundId={id}
 *   Lists persisted PureTrackGroup records for a round.
 *   Auth: Admin, or RoundsCoord scoped to the round's organising club.
 */

import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { randomUUID } from "node:crypto";
import type { Round, PureTrackGroup } from "@bccweb/types";
import { RoundSchema } from "@bccweb/schemas";
import * as z from "zod/v4";
import { getPrivateBlobClient } from "../lib/blob.js";
import { readJson } from "../lib/blobJson.js";
import {
  getCallerIdentity,
  unauthorizedResponse,
  forbiddenResponse,
} from "../lib/auth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";
import { mutationRateLimit } from "../lib/rateLimit.js";
import {
  authenticate,
  deleteGroups,
  listMyGroups,
  PureTrackDeleteError,
} from "../lib/puretrack.js";
import {
  acquirePureTrackMutationGuard,
  assertPureTrackGuardOwned,
  PURETRACK_STALE_GUARD_MS,
  releasePureTrackGuard,
} from "../lib/puretrackGuard.js";
import { mutatePureTrackEchoes, setPureTrackStatus } from "../lib/puretrackStatus.js";
import { parsePureTrackRecord } from "../lib/puretrackRecord.js";
import { enqueuePureTrackGroupJob } from "../lib/queue.js";
import { getBlobServiceClient } from "../lib/storageClients.js";

const DeletePureTrackGroupsBodySchema = z.object({
  // The 10m host budget reserves 60s for reconciliation after three fixed 60s
  // upstream calls (login, CSRF page, list) plus at most five 60s DELETEs.
  ids: z.array(z.number().int().positive()).min(1).max(5).refine(
    (ids) => new Set(ids).size === ids.length,
    "ids must be unique",
  ),
}).strict();

function isCoord(roles: string[]): boolean {
  return roles.includes("RoundsCoord") || roles.includes("Admin");
}

function isAdmin(roles: string[]): boolean {
  return roles.includes("Admin");
}

// ─── Private container accessor (listing only) ────────────────────────────────

function getPrivateContainerClient() {
  const name = process.env["BLOB_PRIVATE_CONTAINER_NAME"] ?? "data-private";
  return getBlobServiceClient().getContainerClient(name);
}

async function listPureTrackGroupsForRound(roundId: string): Promise<PureTrackGroup[]> {
  const container = getPrivateContainerClient();
  const groups: PureTrackGroup[] = [];

  for await (const item of container.listBlobsFlat({ prefix: "puretrack-groups/" })) {
    if (!item.name.endsWith(".json")) continue;
    try {
      const blobClient = container.getBlobClient(item.name);
      const response = await blobClient.download();
      const chunks: Buffer[] = [];
      for await (const chunk of response.readableStreamBody!) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as PureTrackGroup;
      if (data.roundId === roundId) {
        groups.push(data);
      }
    } catch {
      // skip unreadable blobs
    }
  }

  return groups;
}

type PureTrackRecordRef = {
  readonly path: string;
  readonly roundId: string;
  readonly externalId: number;
};

async function listPureTrackRecordRefs(ids: ReadonlySet<number>): Promise<PureTrackRecordRef[]> {
  const container = getPrivateContainerClient();
  const records: PureTrackRecordRef[] = [];
  for await (const item of container.listBlobsFlat({ prefix: "puretrack-groups/" })) {
    if (!item.name.endsWith(".json")) continue;
    let buffer: Buffer;
    try {
      buffer = await container.getBlockBlobClient(item.name).downloadToBuffer();
    } catch (error: unknown) {
      if (!(error instanceof Object) || !("statusCode" in error) || error.statusCode !== 404) {
        throw error;
      }
      continue;
    }
    const parsed = parsePureTrackRecord(buffer, item.name);
    if (parsed === null) continue;
    const externalId = Number(parsed.externalId);
    if (Number.isSafeInteger(externalId) && ids.has(externalId)) {
      records.push({ path: item.name, roundId: parsed.roundId, externalId });
    }
  }
  return records;
}

async function listRoundsWithPureTrackEchoes(ids: ReadonlySet<number>): Promise<string[]> {
  const container = getPrivateContainerClient();
  const roundIds = new Set<string>();
  for await (const item of container.listBlobsFlat({ prefix: "rounds/" })) {
    if (!item.name.endsWith(".json")) continue;
    try {
      const round = await readJson(container.getBlobClient(item.name), RoundSchema, item.name);
      if (
        (round.pureTrackGroupId !== undefined && ids.has(round.pureTrackGroupId)) ||
        round.teams.some(
          (team) => team.pureTrackGroupId !== undefined && ids.has(team.pureTrackGroupId),
        )
      ) {
        roundIds.add(round.id);
      }
    } catch (error: unknown) {
      if (!(error instanceof Object) || !("statusCode" in error) || error.statusCode !== 404) {
        throw error;
      }
    }
  }
  return [...roundIds];
}

async function clearDeletedPureTrackState(ids: readonly number[]): Promise<void> {
  const deletedIds = new Set(ids);
  if (deletedIds.size === 0) return;
  const records = await listPureTrackRecordRefs(deletedIds);
  const roundIds = new Set([
    ...records.map((record) => record.roundId),
    ...await listRoundsWithPureTrackEchoes(deletedIds),
  ]);

  for (const roundId of roundIds) {
    await mutatePureTrackEchoes(roundId, ({ round, brief }) => {
      let changed = false;
      if (round.pureTrackGroupId !== undefined && deletedIds.has(round.pureTrackGroupId)) {
        delete round.pureTrackGroupId;
        delete round.pureTrackGroupName;
        delete round.pureTrackGroupSlug;
        delete brief.pureTrackGroupName;
        delete brief.pureTrackGroupSlug;
        changed = true;
      }
      for (const team of round.teams) {
        if (team.pureTrackGroupId === undefined || !deletedIds.has(team.pureTrackGroupId)) continue;
        const groupId = team.pureTrackGroupId;
        delete team.pureTrackGroupId;
        delete team.pureTrackGroupSlug;
        for (const briefTeam of brief.teams) {
          if (briefTeam.pureTrackGroupId !== groupId) continue;
          delete briefTeam.pureTrackGroupId;
          delete briefTeam.pureTrackGroupSlug;
        }
        changed = true;
      }
      if (changed) delete round.pureTrack;
      return changed;
    });
  }
  const container = getPrivateContainerClient();
  await Promise.all(records.map((record) => container.getBlobClient(record.path).deleteIfExists()));
}

// ─── POST /api/rounds/{id}/puretrack/create-groups ───────────────────────────

async function createPureTrackGroupsHandler(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isCoord(caller.roles)) return forbiddenResponse();

  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_ROUND_ID", "Missing round id");

  let round: Round;
  try {
    const roundPath = `rounds/${id}.json`;
    round = await readJson(getPrivateBlobClient(roundPath), RoundSchema, roundPath);
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Round not found");
    }
    throw new HttpError(500, "INTERNAL");
  }

  if (!isAdmin(caller.roles) && round.organisingClub?.id !== caller.clubId) {
    return forbiddenResponse();
  }

  await mutationRateLimit(req, caller, "createPureTrackGroups", "heavy");

  const attemptId = randomUUID();
  const { updated, previousStatus } = await setPureTrackStatus(id, "pending", {
    newAttemptId: attemptId,
    requestedBy: caller.userId,
    requireRoundStatuses: ["Locked", "Complete"],
    rejectStatuses: ["pending", "processing"],
    supersedeRejectedAfterMs: PURETRACK_STALE_GUARD_MS,
  });
  if (!updated) {
    if (previousStatus === "pending" || previousStatus === "processing") {
      throw new HttpError(
        409,
        "PURETRACK_IN_PROGRESS",
        "PureTrack group creation is already in progress",
      );
    }
    throw new HttpError(
      409,
      "CONFLICT",
      "PureTrack groups can only be created for Locked or Complete rounds",
    );
  }

  try {
    await enqueuePureTrackGroupJob({ roundId: id, attemptId });
  } catch (error: unknown) {
    await setPureTrackStatus(id, "failed", {
      error: "enqueue_failed",
      expectAttemptId: attemptId,
      fromStatuses: ["pending", "processing"],
    }).catch(() => {});
    throw error;
  }

  return { status: 202, jsonBody: { status: "pending" } };
}

// ─── GET /api/manage/puretrack/groups ─────────────────────────────────────────

async function listPureTrackGroupsHandler(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isCoord(caller.roles)) return forbiddenResponse();

  const roundId = req.query.get("roundId");
  if (!roundId) throw new HttpError(400, "MISSING_ROUND_ID", "roundId query parameter is required");

  if (!isAdmin(caller.roles)) {
    // RoundsCoord: verify they belong to the round's organising club
    let round: Round;
    try {
      const roundPath = `rounds/${roundId}.json`;
      round = await readJson(getPrivateBlobClient(roundPath), RoundSchema, roundPath);
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode === 404) {
        throw new HttpError(404, "NOT_FOUND", "Round not found");
      }
      throw new HttpError(500, "INTERNAL");
    }

    if (!round.organisingClub || round.organisingClub.id !== caller.clubId) {
      return forbiddenResponse();
    }
  }

  const groups = await listPureTrackGroupsForRound(roundId);
  return { status: 200, jsonBody: groups };
}

// ─── GET /api/manage/puretrack/groups/live ────────────────────────────────────

async function listLivePureTrackGroupsHandler(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isAdmin(caller.roles)) return forbiddenResponse();

  const handle = await acquirePureTrackMutationGuard("global", randomUUID());
  if (handle === null) {
    throw new HttpError(409, "PURETRACK_IN_PROGRESS", "A PureTrack mutation is already in progress");
  }
  const beforeOutbound = () => assertPureTrackGuardOwned(handle);
  try {
    const session = await authenticate(beforeOutbound);
    return { status: 200, jsonBody: await listMyGroups(session, beforeOutbound) };
  } finally {
    await releasePureTrackGuard(handle);
  }
}

// ─── POST /api/manage/puretrack/groups/delete ─────────────────────────────────

async function deletePureTrackGroupsHandler(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isAdmin(caller.roles)) return forbiddenResponse();

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, "INVALID_BODY", "Expected a JSON body");
  }
  const parsed = DeletePureTrackGroupsBodySchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(400, "INVALID_IDS", "ids must contain 1 to 5 unique positive integers");
  }

  await mutationRateLimit(req, caller, "deletePureTrackGroups", "heavy");
  const handle = await acquirePureTrackMutationGuard("global", randomUUID());
  if (handle === null) {
    throw new HttpError(409, "PURETRACK_IN_PROGRESS", "A PureTrack mutation is already in progress");
  }

  const beforeOutbound = () => assertPureTrackGuardOwned(handle);
  try {
    const session = await authenticate(beforeOutbound);
    const liveIds = new Set((await listMyGroups(session, beforeOutbound)).map((group) => group.id));
    const idsToDelete = parsed.data.ids.filter((id) => liveIds.has(id));
    const alreadyGoneIds = parsed.data.ids.filter((id) => !liveIds.has(id));
    try {
      const deleteResult = await deleteGroups(session, idsToDelete, beforeOutbound);
      const actualAlreadyGoneIds = [...new Set([
        ...alreadyGoneIds,
        ...deleteResult.alreadyGoneIds,
      ])];
      await clearDeletedPureTrackState([
        ...deleteResult.deletedIds,
        ...actualAlreadyGoneIds,
      ]);
      return {
        status: 200,
        jsonBody: {
          deleted: deleteResult.deletedIds.length,
          alreadyGone: actualAlreadyGoneIds.length,
        },
      };
    } catch (error: unknown) {
      if (error instanceof PureTrackDeleteError) {
        await clearDeletedPureTrackState([
          ...alreadyGoneIds,
          ...error.deletedIds,
          ...error.alreadyGoneIds,
        ]);
      }
      throw error;
    }
  } finally {
    await releasePureTrackGuard(handle);
  }
}

// ─── Registration ─────────────────────────────────────────────────────────────

app.http("createPureTrackGroups", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{id}/puretrack/create-groups",
  handler: withErrorHandler(createPureTrackGroupsHandler),
});

app.http("listPureTrackGroups", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "manage/puretrack/groups",
  handler: withErrorHandler(listPureTrackGroupsHandler),
});

app.http("listLivePureTrackGroups", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "manage/puretrack/groups/live",
  handler: withErrorHandler(listLivePureTrackGroupsHandler),
});

app.http("deletePureTrackGroups", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "manage/puretrack/groups/delete",
  handler: withErrorHandler(deletePureTrackGroupsHandler),
});
