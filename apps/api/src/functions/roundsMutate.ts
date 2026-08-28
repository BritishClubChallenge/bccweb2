// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * Round write endpoints — Phase 3
 *
 * POST   /api/rounds                       — create round
 * PUT    /api/rounds/{id}                  — update round metadata
 * POST   /api/rounds/{id}/confirm          — Proposed → Confirmed
 * POST   /api/rounds/{id}/brief-complete   — Confirmed → BriefComplete
 * POST   /api/rounds/{id}/reopen           — BriefComplete → Confirmed
 * POST   /api/rounds/{id}/lock             — BriefComplete → Locked + snapshot pilots
 * POST   /api/rounds/{id}/unlock           — Locked → Confirmed
 * POST   /api/rounds/{id}/cancel           — Proposed | Confirmed → Cancelled
 * POST   /api/rounds/{id}/uncancel         — Cancelled → Proposed
 * POST   /api/rounds/{id}/complete         — Locked → Complete + score + recompute
 *
 * The four PURE status transitions (confirm, reopen, cancel, uncancel) are
 * table-driven and live in lib/roundTransitions.ts; the handlers below are
 * one-liners over `applyRoundTransition`. Everything still in this file does
 * work beyond `round.status = to`.
 */

import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { randomUUID } from "node:crypto";
import type {
  CallerIdentity,
  Round,
  RoundStatus,
  Season,
  Site,
  Config,
  PilotSummary,
  PilotSnapshot,
  RoundBrief,
  BriefTeamEntry,
  BriefVersion,
  Signature,
} from "@bccweb/types";
import { normalizeStatus, isRosterFrozen, rosterFrozenReason } from "@bccweb/types";
import {
  BriefSchema,
  ConfigSchema,
  PilotSchema,
  PilotSummarySchema,
  RoundSchema,
  SeasonSchema,
  SiteSchema,
} from "@bccweb/schemas";
import * as z from "zod/v4";
import { scoreRoundEnforcingValidation } from "../lib/scoreRoundValidated.js";
import {
  getBlobClient,
  getPrivateBlobClient,
  getPrivateBlockBlobClient,
  withLease,
  withPrivateLease,
  withPrivateLeaseRenewing,
  withRoundAndBriefLease,
} from "../lib/blob.js";
import { readJson, writeJson, writePrivateJson } from "../lib/blobJson.js";
import {
  getCallerIdentity,
  unauthorizedResponse,
  forbiddenResponse,
} from "../lib/auth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";
import { assertCanManageRound, isCoord } from "../lib/roundAuth.js";
import { applyRoundTransition } from "../lib/roundTransitions.js";
import { mutationRateLimit } from "../lib/rateLimit.js";
import { updateRoundsIndex, recomputeSeason } from "../lib/recompute.js";
import { setBriefPdfStatus } from "../lib/briefPdf.js";
import { enqueueBriefPdf, enqueuePureTrackGroupJob } from "../lib/queue.js";
import {
  clearPureTrackEchoes,
  mutatePureTrackEchoes,
  setPureTrackStatus,
} from "../lib/puretrackStatus.js";
import { getTelemetryClient } from "../lib/telemetry.js";
import { listSignaturesForRound } from "../lib/signTofly/ledger.js";
import { findUnsignedSlots } from "../lib/signTofly/completeness.js";
import { findUnaccountedSlots, formatSlotRefs } from "../lib/roundGates.js";
import { materializeSignToFly } from "../lib/signTofly/reflect.js";
import { slotKey } from "../lib/signTofly/slotSignatureVersions.js";
import { invalidatePriorSignToFlyFlags } from "../lib/signTofly/invalidate.js";
import { computeBriefHash, MATERIAL_BRIEF_FIELDS } from "../lib/signTofly/briefVersion.js";

/** The three coordinator-authored times that now live on the brief, not the Round. */
export interface BriefTimes {
  briefingTime?: string;
  checkInByTime?: string;
  landByTime?: string;
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────

async function assertManageableRound(
  caller: CallerIdentity,
  id: string,
): Promise<void> {
  const path = `rounds/${id}.json`;
  let round: Round;
  try {
    round = await readJson(getPrivateBlobClient(path), RoundSchema, path);
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Round not found");
    }
    throw new HttpError(500, "INTERNAL");
  }
  assertCanManageRound(caller, round);
}

// Schemas for blobs without dedicated re-exports.
const PilotSummariesSchema = z.array(PilotSummarySchema);
const ClubRefSchema = z
  .object({ id: z.string().min(1), name: z.string().min(1) })
  .strip();

async function loadConfig(): Promise<Config> {
  try {
    return await readJson(
      getPrivateBlobClient("config.json"),
      ConfigSchema,
      "config.json",
    );
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      error.statusCode === 404
    ) {
      return ConfigSchema.parse({});
    }
    throw error;
  }
}

// ─── POST /api/rounds ─────────────────────────────────────────────────────────

async function createRound(
  req: HttpRequest,
  ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isCoord(caller.roles)) return forbiddenResponse();

  const body = (await req.json()) as {
    date?: string;
    siteId?: string;
    seasonYear?: number;
    organisingClubId?: string;
    maxTeams?: number;
    minimumScore?: number;
    briefingTime?: string;
    landByTime?: string;
    checkInByTime?: string;
    status?: string;
  };

  const { date, siteId, seasonYear } = body;
  if (!date || !siteId || !seasonYear) {
    throw new HttpError(400, "INVALID_BODY", "date, siteId, and seasonYear are required");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new HttpError(400, "INVALID_DATE", "date must be yyyy-MM-dd");
  }

  // A non-admin coord may only organise rounds for their own club, and must have one.
  const isAdmin = caller.roles.includes("Admin");
  if (!isAdmin && !caller.clubId) {
    return forbiddenResponse("Your account is not linked to a club");
  }
  if (!isAdmin && body.organisingClubId && body.organisingClubId !== caller.clubId) {
    return forbiddenResponse("You can only create rounds for your own club");
  }
  const organisingClubId = isAdmin ? body.organisingClubId : caller.clubId;

  await mutationRateLimit(req, caller, "createRound", "standard");

  // Load site
  let site: Site;
  try {
    const sitePath = `sites/${siteId}.json`;
    site = await readJson(getPrivateBlobClient(sitePath), SiteSchema, sitePath);
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(400, "INVALID_BODY", "Site not found");
    }
    throw new HttpError(500, "INTERNAL");
  }

  // Load season (must exist)
  let season: Season;
  try {
    const seasonPath = `seasons/${seasonYear}.json`;
    season = await readJson(getBlobClient(seasonPath), SeasonSchema, seasonPath);
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(400, "INVALID_BODY", "Season not found");
    }
    throw new HttpError(500, "INTERNAL");
  }

  let organisingClub: { id: string; name: string } | undefined;
  if (organisingClubId) {
    try {
      const clubPath = `clubs/${organisingClubId}.json`;
      const club = await readJson(getPrivateBlobClient(clubPath), ClubRefSchema, clubPath);
      organisingClub = { id: club.id, name: club.name };
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode === 404) {
        throw new HttpError(400, "CLUB_NOT_FOUND", "Organising club not found");
      }
      throw new HttpError(500, "INTERNAL");
    }
  }

  const id = randomUUID();
  // Lifecycle invariant: a round is ALWAYS created Proposed. Accepting any other
  // status here would let a caller skip the freeze lifecycle (confirm →
  // brief-complete → lock), so a provided status is honoured only when it
  // normalizes to Proposed; anything else (or an unknown value) is a 400.
  if (body.status !== undefined) {
    let requested: RoundStatus;
    try {
      requested = normalizeStatus(body.status);
    } catch (err: unknown) {
      const message = (err as { message?: string }).message ?? "Unknown status";
      return {
        status: 400,
        jsonBody: { error: "Invalid status", code: "INVALID_STATUS", detail: message },
      };
    }
    if (requested !== "Proposed") {
      return {
        status: 400,
        jsonBody: {
          error: "Invalid status",
          code: "INVALID_STATUS",
          detail: `Rounds must be created with status Proposed (received ${requested})`,
        },
      };
    }
  }
  const round: Round = {
    id,
    date,
    status: "Proposed",
    isLocked: false,
    maxTeams: body.maxTeams ?? 8,
    minimumScore: body.minimumScore ?? 0,
    site: {
      id: site.id,
      name: site.name,
      parkingW3W: site.parkingW3W,
      briefingW3W: site.briefingW3W,
      takeOffW3W: site.takeOffW3W,
    },
    organisingClub,
    season: { year: Number(seasonYear) },
    teams: [],
  };

  // Write primary round blob
  await writePrivateJson(`rounds/${id}.json`, RoundSchema, round);

  // Append round ID to season (with lease for atomicity)
  try {
    await withLease(`seasons/${seasonYear}.json`, async (leaseId) => {
      const seasonPath = `seasons/${seasonYear}.json`;
      const s = await readJson(getBlobClient(seasonPath), SeasonSchema, seasonPath);
      if (!s.rounds.includes(id)) {
        s.rounds.push(id);
      }
      await writeJson(seasonPath, SeasonSchema, s, leaseId);
    });
  } catch {
    // Season blob just checked to exist — this should not fail; best-effort
    season.rounds.push(id);
    await writeJson(`seasons/${seasonYear}.json`, SeasonSchema, season);
  }

  // Update rounds.json index
  await updateRoundsIndex(round);

  // Seed the brief at creation so coordinators land on a populated brief-edit UI.
  // Best-effort: a failure MUST NOT fail the round create — the brief is
  // recoverable via lazy-create on first edit/image (T6/T9). ifNoneMatch:"*" is
  // atomic create-or-skip, so it never clobbers a brief that already exists.
  try {
    const brief = await buildInitialBrief(round, {
      briefingTime: body.briefingTime,
      checkInByTime: body.checkInByTime,
      landByTime: body.landByTime,
    });
    await writePrivateJson(`round-briefs/${id}.json`, BriefSchema, brief, undefined, {
      ifNoneMatch: "*",
    });
  } catch (briefErr) {
    ctx.warn(`[createRound:${id}] Eager brief creation failed (recoverable):`, briefErr);
    getTelemetryClient()?.trackTrace({
      message: "brief.eagerCreateFailed",
      properties: { roundId: id },
    });
  }

  return { status: 201, jsonBody: round };
}

// ─── PUT /api/rounds/{id} ─────────────────────────────────────────────────────

async function updateRound(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isCoord(caller.roles)) return forbiddenResponse();

  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_ROUND_ID", "Missing round id");

  await assertManageableRound(caller, id);

  const body = (await req.json()) as {
    date?: string;
    siteId?: string;
    organisingClubId?: string;
    maxTeams?: number;
    minimumScore?: number;
  };

  if (
    !caller.roles.includes("Admin") &&
    body.organisingClubId &&
    body.organisingClubId !== caller.clubId
  ) {
    return forbiddenResponse("You can only assign rounds to your own club");
  }

  await mutationRateLimit(req, caller, "updateRound", "standard");

  const path = `rounds/${id}.json`;
  let updated: Round;
  let dateChanged = false;

  try {
    updated = await withPrivateLease(path, async (leaseId) => {
      const r = await readJson(getPrivateBlobClient(path), RoundSchema, path);

      // Cancelled first: isRosterFrozen("Cancelled") is true as well, and the
      // cancelled rejection must stay distinguishable from the frozen one.
      if (r.status === "Cancelled") {
        throw new HttpError(409, "ROUND_CANCELLED", "Round is cancelled — uncancel before editing");
      }

      // The Fixture — when the round is held, where, who hosts it and how many
      // teams it has room for — is settled from BriefComplete onward, the same
      // rule the roster uses. By then everyone is standing on the hill and the
      // brief pilots signed against describes this site. A round arranged wrongly
      // is cancelled and re-scheduled, never re-pointed. (CONTEXT.md: Fixture)
      if (isRosterFrozen(r.status)) {
        throw new HttpError(
          409,
          "CONFLICT",
          `Cannot change the round's date, site, organising club or capacity while ${rosterFrozenReason(r.status)}`,
        );
      }

      if (body.date && body.date !== r.date) {
        dateChanged = true;
        r.date = body.date;
        for (const team of r.teams) {
          for (const slot of team.pilots) {
            const flight = slot.flight;
            if (!flight) continue;
            if (flight.validation) {
              const validation = { ...flight.validation };
              delete validation.date;
              flight.validation = validation;
            }
            if (flight.sanityFlags) {
              flight.sanityFlags = flight.sanityFlags.filter(
                (flag) => flag !== "IGC_DATE_MISMATCH"
              );
            }
          }
        }
      }
      if (body.maxTeams !== undefined) r.maxTeams = body.maxTeams;
      if (body.minimumScore !== undefined) r.minimumScore = body.minimumScore;

      // Update site if changed
      if (body.siteId && body.siteId !== r.site.id) {
        let site: Site;
        try {
          const sitePath = `sites/${body.siteId}.json`;
          site = await readJson(getPrivateBlobClient(sitePath), SiteSchema, sitePath);
        } catch {
          throw new HttpError(409, "CONFLICT", "Site not found");
        }
        r.site = {
          id: site.id,
          name: site.name,
          parkingW3W: site.parkingW3W,
          briefingW3W: site.briefingW3W,
          takeOffW3W: site.takeOffW3W,
        };
      }

      if (body.organisingClubId) {
        try {
          const clubPath = `clubs/${body.organisingClubId}.json`;
          const club = await readJson(getPrivateBlobClient(clubPath), ClubRefSchema, clubPath);
          r.organisingClub = { id: club.id, name: club.name };
        } catch (err: unknown) {
          if ((err as { statusCode?: number }).statusCode === 404) {
            throw new HttpError(400, "CLUB_NOT_FOUND", "Organising club not found");
          }
          throw new HttpError(500, "INTERNAL");
        }
      }

      if (dateChanged) {
        const { round: scored, derivation } = scoreRoundEnforcingValidation(
          r,
          await loadConfig(),
        );
        scored.scoring = { scoredAt: new Date().toISOString(), ...derivation };
      }

      await writePrivateJson(path, RoundSchema, r, leaseId);
      return r;
    });
  } catch (err: unknown) {
    if (err instanceof HttpError) throw err;
    const e = err as { statusCode?: number };
    if (e.statusCode === 404) throw new HttpError(404, "NOT_FOUND", "Round not found");
    throw new HttpError(500, "INTERNAL");
  }

  await updateRoundsIndex(updated);
  return { status: 200, jsonBody: updated };
}

// ─── POST /api/rounds/{id}/confirm ────────────────────────────────────────────

async function confirmRound(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  return { status: 200, jsonBody: await applyRoundTransition(req, "confirm") };
}

// ─── POST /api/rounds/{id}/brief-complete ─────────────────────────────────────

interface CompleteBriefContext {
  briefTeams: BriefTeamEntry[];
  callerUserId: string;
  roundLeaseId: string;
  briefLeaseId: string;
}

/**
 * Every Filled round slot must be snapshot-able — i.e. present in
 * buildBriefTeams(round) (which only yields pilots that already carry a
 * snapshot). A Filled slot missing from the brief teams means a pilot cannot be
 * safely frozen before signing, so brief-complete aborts (409) rather than
 * advancing to a state where pilots could sign against an incomplete roster.
 */
function assertRosterComplete(round: Round, briefTeams: BriefTeamEntry[]): void {
  const snapshotted = new Set<string>();
  for (const team of briefTeams) {
    for (const pilot of team.pilots) {
      snapshotted.add(`${pilot.pilotId}:${pilot.placeInTeam}`);
    }
  }
  for (const team of round.teams) {
    for (const slot of team.pilots) {
      if (
        slot.status === "Filled" &&
        slot.pilotId &&
        !snapshotted.has(`${slot.pilotId}:${slot.placeInTeam}`)
      ) {
        throw new HttpError(
          409,
          "ROSTER_INCOMPLETE",
          "Every filled slot must be snapshot-able before brief-complete",
        );
      }
    }
  }
}

/**
 * Shared count core for brief-complete so the real transaction and its dryRun
 * preview derive `invalidatedSignatureCount` identically. MUTATES `brief`
 * (freeze/version bump) and `round` (sign-to-fly invalidation) but performs NO
 * persistence: the real path persists afterwards; the dryRun path MUST pass
 * CLONES so nothing is written.
 */
function freezeBriefAndCountInvalidations(
  round: Round,
  brief: RoundBrief,
  signatures: Signature[],
  briefTeams: BriefTeamEntry[],
  callerUserId: string,
): number {
  const now = new Date().toISOString();

  brief.teams = briefTeams;
  brief.date = round.date;
  brief.siteName = round.site.name;
  brief.organisingClubName = round.organisingClub?.name;
  brief.pureTrackGroupName = round.pureTrackGroupName;
  brief.pureTrackGroupSlug = round.pureTrackGroupSlug;

  const newHash = computeBriefHash(brief);
  if (brief.hash === undefined) {
    brief.hash = newHash;
  } else if (brief.hash !== newHash) {
    const archived: BriefVersion = {
      version: brief.version ?? 1,
      hash: brief.hash,
      createdAt: brief.generatedAt ?? now,
      createdBy: callerUserId,
      supersededAt: now,
    };
    brief.versionHistory = [...(brief.versionHistory ?? []), archived];
    brief.version = (brief.version ?? 1) + 1;
    brief.hash = newHash;
  }

  const signedBefore = new Map<string, boolean>();
  for (const team of round.teams) {
    for (const slot of team.pilots) {
      signedBefore.set(slotKey(team.id, slot.placeInTeam), slot.signToFly);
    }
  }
  invalidatePriorSignToFlyFlags(round, brief, signatures);
  let invalidatedSignatureCount = 0;
  for (const team of round.teams) {
    for (const slot of team.pilots) {
      if (
        signedBefore.get(slotKey(team.id, slot.placeInTeam)) === true &&
        slot.signToFly === false
      ) {
        invalidatedSignatureCount += 1;
      }
    }
  }
  return invalidatedSignatureCount;
}

/**
 * The atomic brief-complete body (R8) — runs as ONE unit under the round+brief
 * leases acquired by withRoundAndBriefLease. It MUST NOT be split into separate
 * transactions. In order:
 *   1. Refresh NON-material derived metadata (teams/date/siteName/club/PureTrack
 *      names) so downstream PDF/email never read stale copies. None of these are
 *      MATERIAL_BRIEF_FIELDS, so the freeze hash is unaffected.
 *   2. Freeze the material hash: the first freeze sets `hash` and keeps
 *      `version`; a material change archives the prior {version, hash, createdAt,
 *      createdBy, supersededAt} onto versionHistory (ALL BriefVersionSchema
 *      required fields), bumps `version`, and sets the new hash.
 *   3. Persist the frozen brief JSON (PDF generation stays OUTSIDE the lease).
 *   4. ALWAYS invalidate prior sign-to-fly flags keyed on the now-current brief
 *      version (retry-safe — NOT gated on whether THIS call bumped), then persist
 *      the flag resets onto the round.
 * Steps 1-2 + the invalidation-count of 4 are delegated to
 * freezeBriefAndCountInvalidations (shared with the dryRun preview); this
 * function adds the persistence (brief-before-round preserves the R8 write order).
 * Returns the number of signatures invalidated by this call.
 */
async function completeBriefTransaction(
  round: Round,
  brief: RoundBrief,
  signatures: Signature[],
  ctx: CompleteBriefContext,
): Promise<number> {
  const invalidatedSignatureCount = freezeBriefAndCountInvalidations(
    round,
    brief,
    signatures,
    ctx.briefTeams,
    ctx.callerUserId,
  );

  await writePrivateJson(
    `round-briefs/${round.id}.json`,
    BriefSchema,
    brief,
    ctx.briefLeaseId,
  );

  await writePrivateJson(`rounds/${round.id}.json`, RoundSchema, round, ctx.roundLeaseId);

  return invalidatedSignatureCount;
}

/** Slots currently signed (signToFly === true) — the reopen dryRun's at-risk count. */
function countCurrentlySignedSlots(round: Round): number {
  let count = 0;
  for (const team of round.teams) {
    for (const slot of team.pilots) {
      if (slot.signToFly === true) count += 1;
    }
  }
  return count;
}

/**
 * POST /api/rounds/{id}/brief-complete — Confirmed → BriefComplete.
 *
 * The Confirmed→BriefComplete transition that FREEZES the brief and invalidates
 * stale sign-to-fly flags. The freeze body runs UNDER the round lease with the
 * brief lease NESTED (B3) via withRoundAndBriefLease so the brief write is
 * covered atomically.
 *
 * G2 (BLOCKING): the brief MUST already exist — this safety path never
 * lazy-creates one (and you cannot lease a missing blob). Aborts 409 if the
 * brief is absent (`BRIEF_REQUIRED`) or the roster is incomplete (a Filled slot
 * is not snapshot-able). Responds with the round plus `invalidatedSignatureCount`.
 */
async function briefCompleteRound(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_ROUND_ID", "Missing round id");

  const dryRun = req.query.get("dryRun") === "true";

  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isCoord(caller.roles)) return forbiddenResponse();
  await assertManageableRound(caller, id);
  await mutationRateLimit(req, caller, "briefCompleteRound", "standard");

  const roundPath = `rounds/${id}.json`;

  // G2: brief must exist before the lease — withRoundAndBriefLease cannot lease
  // a missing brief blob, and this safety path never lazy-creates one.
  let preRound: Round;
  try {
    preRound = await readJson(getPrivateBlobClient(roundPath), RoundSchema, roundPath);
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Round not found");
    }
    throw new HttpError(500, "INTERNAL");
  }
  if (preRound.status !== "Confirmed") {
    throw new HttpError(409, "CONFLICT", `Expected status Confirmed, got ${preRound.status}`);
  }
  const preBrief = await readExistingBriefForLock(id);
  if (!preBrief) {
    throw new HttpError(409, "BRIEF_REQUIRED", "A brief must exist before brief-complete");
  }

  // dryRun preview: same preconditions, but compute the count on CLONES so
  // nothing persists (freezeBriefAndCountInvalidations MUTATES its args). Powers
  // the RoundManage confirm modal without transitioning on modal-open.
  if (dryRun) {
    const briefTeams = await buildBriefTeams(preRound);
    assertRosterComplete(preRound, briefTeams);
    const signatures = await listSignaturesForRound(id);
    const invalidatedSignatureCount = freezeBriefAndCountInvalidations(
      structuredClone(preRound),
      structuredClone(preBrief),
      signatures,
      briefTeams,
      caller.userId,
    );
    return { status: 200, jsonBody: { invalidatedSignatureCount } };
  }

  let updatedRound: Round;
  let invalidatedSignatureCount: number;
  try {
    const result = await withRoundAndBriefLease(id, async (roundLeaseId, briefLeaseId) => {
      const r = await readJson(getPrivateBlobClient(roundPath), RoundSchema, roundPath);
      if (r.status !== "Confirmed") {
        throw new HttpError(409, "CONFLICT", `Expected status Confirmed, got ${r.status}`);
      }
      const briefPath = `round-briefs/${id}.json`;
      const brief = await readJson(getPrivateBlobClient(briefPath), BriefSchema, briefPath);

      // Roster completeness BEFORE any write — every Filled slot must be
      // snapshot-able so pilots can be safely frozen before signing.
      const briefTeams = await buildBriefTeams(r);
      assertRosterComplete(r, briefTeams);

      r.status = "BriefComplete";
      const signatures = await listSignaturesForRound(id);
      const count = await completeBriefTransaction(r, brief, signatures, {
        briefTeams,
        callerUserId: caller.userId,
        roundLeaseId,
        briefLeaseId,
      });
      return { round: r, count };
    });
    updatedRound = result.round;
    invalidatedSignatureCount = result.count;
  } catch (err: unknown) {
    if (err instanceof HttpError) throw err;
    const e = err as { statusCode?: number };
    if (e.statusCode === 404) throw new HttpError(404, "NOT_FOUND", "Round not found");
    throw new HttpError(500, "INTERNAL");
  }

  await updateRoundsIndex(updatedRound);
  return { status: 200, jsonBody: { ...updatedRound, invalidatedSignatureCount } };
}

// ─── POST /api/rounds/{id}/reopen ─────────────────────────────────────────────

/**
 * POST /api/rounds/{id}/reopen — BriefComplete → Confirmed.
 *
 * Re-opens a brief-complete round for further brief edits. Signatures PERSIST
 * across the reopen (Option A — they are NOT voided here); a subsequent material
 * brief edit + brief-complete is what invalidates stale ones (keyed on the brief
 * version bump). The response mirrors brief-complete by carrying
 * `invalidatedSignatureCount` (always 0 — reopen invalidates nothing).
 */
async function reopenBrief(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_ROUND_ID", "Missing round id");

  const dryRun = req.query.get("dryRun") === "true";

  // dryRun preview: validate BriefComplete (409 otherwise, matching the real
  // transition) and report how many currently-signed slots the reopen puts at
  // risk, WITHOUT changing status. Powers the RoundManage confirm modal.
  //
  // It carries its OWN auth preamble because it never reaches
  // applyRoundTransition. Keeping the preamble here rather than above the
  // branch is what stops the real path charging the reopenBrief bucket twice
  // (30/min would become 15/min) — each path charges exactly one token.
  if (dryRun) {
    const caller = await getCallerIdentity(req);
    if (!caller) return unauthorizedResponse();
    if (!isCoord(caller.roles)) return forbiddenResponse();
    await assertManageableRound(caller, id);
    await mutationRateLimit(req, caller, "reopenBrief", "standard");

    const path = `rounds/${id}.json`;
    let round: Round;
    try {
      round = await readJson(getPrivateBlobClient(path), RoundSchema, path);
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode === 404) {
        throw new HttpError(404, "NOT_FOUND", "Round not found");
      }
      throw new HttpError(500, "INTERNAL");
    }
    if (round.status !== "BriefComplete") {
      throw new HttpError(409, "CONFLICT", `Expected status BriefComplete, got ${round.status}`);
    }
    return {
      status: 200,
      jsonBody: { invalidatedSignatureCount: countCurrentlySignedSlots(round) },
    };
  }

  return {
    status: 200,
    jsonBody: {
      ...(await applyRoundTransition(req, "reopen")),
      invalidatedSignatureCount: 0,
    },
  };
}

// ─── POST /api/rounds/{id}/lock ───────────────────────────────────────────────

/**
 * The single brief "seed" source. Shared by every create path — eager create
 * (createRound), lazy-create on first edit (T6) and on first image (T9) — so all
 * three converge on a byte-identical document for the same inputs (bar
 * `generatedAt`). Reads the site INTERNALLY for `guideUrl`; copies siteName/W3W
 * from `round.site` and date/club from the round; leaves safety/narrative blank;
 * sets `imagePaths:[]`, `teams:[]`, `version:1` and NO `hash` (frozen at first
 * brief-complete — T7).
 */
export async function buildInitialBrief(
  round: Round,
  times?: BriefTimes,
): Promise<RoundBrief> {
  let siteGuideUrl: string | undefined;
  try {
    const sitePath = `sites/${round.site.id}.json`;
    const site = await readJson(getPrivateBlobClient(sitePath), SiteSchema, sitePath);
    siteGuideUrl = site.guideUrl;
  } catch {
    siteGuideUrl = undefined;
  }

  return {
    roundId: round.id,
    generatedAt: new Date().toISOString(),
    date: round.date,
    siteName: round.site.name,
    guideUrl: siteGuideUrl,
    parkingW3W: round.site.parkingW3W,
    briefingW3W: round.site.briefingW3W,
    takeOffW3W: round.site.takeOffW3W,
    briefingTime: times?.briefingTime,
    checkInByTime: times?.checkInByTime,
    landByTime: times?.landByTime,
    organisingClubName: round.organisingClub?.name,
    pureTrackGroupName: round.pureTrackGroupName,
    pureTrackGroupSlug: round.pureTrackGroupSlug,
    imagePaths: [],
    version: 1,
    teams: [],
  };
}

export async function buildBriefTeams(round: Round): Promise<BriefTeamEntry[]> {
  const pilotsIndex = await readJson(
    getBlobClient("pilots.json"),
    PilotSummariesSchema,
    "pilots.json",
  ).catch(() => [] as PilotSummary[]);
  const pilotNameMap = new Map(pilotsIndex.map((p) => [p.id, p]));

  return Promise.all(
    round.teams
      .filter((t) => t.pilots.some((s) => s.status === "Filled"))
      .map(async (t) => ({
        teamName: t.teamName,
        clubName: t.club.name,
        pureTrackGroupId: t.pureTrackGroupId,
        pureTrackGroupSlug: t.pureTrackGroupSlug,
        pilots: await Promise.all(
          t.pilots
            .filter((s) => s.status === "Filled" && s.pilotId && s.snapshot)
            .map(async (s) => {
              const pilotMeta = pilotNameMap.get(s.pilotId!);
               let wingManufacturer;
               let bhpaNumber;
               let pureTrackId;
               try {
                 const pilotPath = `pilots/${s.pilotId!}.json`;
                 const pilotDoc = await readJson(
                   getPrivateBlobClient(pilotPath),
                   PilotSchema,
                   pilotPath,
                 );
                 wingManufacturer = pilotDoc.wingManufacturer;
                 bhpaNumber = pilotDoc.bhpaNumber;
                 pureTrackId = pilotDoc.pureTrackId;
               } catch {
                 wingManufacturer = undefined;
               }
               return {
                 placeInTeam: s.placeInTeam,
                 pilotId: s.pilotId!,
                 name: pilotMeta?.name ?? s.pilotId!,
                 bhpaNumber,
                 pureTrackId,
                 ...(wingManufacturer ? { wingManufacturer } : {}),
                 isScoring: s.isScoring,
                 snapshot: s.snapshot!,
               };
            })
        ),
      }))
  );
}

async function readExistingBriefForLock(id: string): Promise<RoundBrief | null> {
  const path = `round-briefs/${id}.json`;
  try {
    return await readJson(getPrivateBlobClient(path), BriefSchema, path);
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) return null;
    throw new HttpError(500, "INTERNAL");
  }
}

async function mergeBriefForLock(
  round: Round,
  existing: RoundBrief
): Promise<RoundBrief> {
  // Lock refreshes ONLY non-material parts of the FROZEN brief: the team roster
  // (re-snapshotted pilots) plus the PureTrack/site/date/club echoes. The frozen
  // brief is the base of truth, so every safety-material field, the cosmetic
  // briefer, and the freeze identity (version/versionHistory/hash) carry over
  // byte-identical and computeBriefHash(result) === existing.hash still holds.
  const merged: RoundBrief = {
    ...existing,
    teams: await buildBriefTeams(round),
    siteName: round.site.name,
    date: round.date,
    organisingClubName: round.organisingClub?.name,
    pureTrackGroupName: round.pureTrackGroupName,
    pureTrackGroupSlug: round.pureTrackGroupSlug,
  };
  // B5: re-impose each frozen material field BY NAME from the SINGLE
  // MATERIAL_BRIEF_FIELDS declaration (no hand-kept copy that can drift), so the
  // hash survives even if the spread above is ever changed to re-derive a
  // material field from the Round. `briefer` is the editable-cosmetic extra; the
  // freeze identity is never re-derived at lock.
  for (const field of MATERIAL_BRIEF_FIELDS) {
    Object.assign(merged, { [field]: existing[field] });
  }
  merged.briefer = existing.briefer;
  merged.version = existing.version;
  merged.versionHistory = existing.versionHistory;
  merged.hash = existing.hash;
  return merged;
}

/**
 * BriefComplete → Locked.
 * Takes a snapshot of each registered pilot's safety/scoring data from
 * their pilot document. Resets accountedFor for all slots; preserves signToFly.
 * After the lock is confirmed, enqueues PureTrack-group and PDF jobs.
 */
async function lockRound(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_ROUND_ID", "Missing round id");

  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isCoord(caller.roles)) return forbiddenResponse();

  const path = `rounds/${id}.json`;

  // Read round first (outside lease) to gather pilot IDs
  let round: Round;
  try {
    round = await readJson(getPrivateBlobClient(path), RoundSchema, path);
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Round not found");
    }
    throw new HttpError(500, "INTERNAL");
  }

  assertCanManageRound(caller, round);
  await mutationRateLimit(req, caller, "lockRound", "heavy");

  if (round.status !== "BriefComplete") {
    return {
      status: 409,
      jsonBody: {
        error: `Round must be BriefComplete to lock (currently ${round.status})`,
      },
    };
  }

  // Load pilot snapshots in parallel (outside the lease — avoids 30s timeout)
  const pilotIds = round.teams.flatMap((t) =>
    t.pilots.filter((s) => s.pilotId && s.status === "Filled").map((s) => s.pilotId!)
  );
  const uniquePilotIds = [...new Set(pilotIds)];

  const snapshotMap = new Map<string, PilotSnapshot>();
  await Promise.all(
    uniquePilotIds.map(async (pilotId) => {
      try {
        const pilotPath = `pilots/${pilotId}.json`;
        const pilot = await readJson(
          getPrivateBlobClient(pilotPath),
          PilotSchema,
          pilotPath,
        );
        snapshotMap.set(pilotId, {
          wingClass: (pilot.wingClass ?? "EN B"),
          pilotRating: pilot.pilotRating,
          phoneNumber: pilot.person?.phoneNumber,
          helmetColour: pilot.helmetColour,
          harnessType: pilot.harnessType,
          harnessColour: pilot.harnessColour,
          wingManufacturer: pilot.wingManufacturer?.name,
          wingModel: pilot.wingModel,
          wingColours: pilot.wingColours,
          emergencyContactName: pilot.emergencyContactName,
          emergencyPhoneNumber: pilot.emergencyPhoneNumber,
          medicalInfo: pilot.medicalInfo,
        });
      } catch {
        // pilot not found — snapshot stays null; log and continue
      }
    })
  );

  const candidateRound = structuredClone(round);
  candidateRound.pureTrackGroupId = undefined;
  candidateRound.pureTrackGroupName = undefined;
  candidateRound.pureTrackGroupSlug = undefined;
  for (const team of candidateRound.teams) {
    team.pureTrackGroupId = undefined;
    team.pureTrackGroupSlug = undefined;
  }
  candidateRound.status = "Locked";
  candidateRound.isLocked = true;
  for (const team of candidateRound.teams) {
    for (const slot of team.pilots) {
      if (slot.pilotId && snapshotMap.has(slot.pilotId)) {
        slot.snapshot = snapshotMap.get(slot.pilotId)!;
      }
      slot.accountedFor = false;
    }
  }

  // B3: the brief is its own blob, so the round lease does NOT cover it. Read
  // the frozen brief, refresh teams, verify the frozen material hash, then
  // persist BOTH the brief JSON and the Locked round atomically under the
  // round+brief leases. The brief must already exist (brief-complete froze it) —
  // a missing blob cannot be leased.
  if (!(await readExistingBriefForLock(id))) {
    throw new HttpError(
      409,
      "BRIEF_REQUIRED",
      "A frozen brief must exist before locking — reopen and re-complete the round",
    );
  }

  const briefPaths = {
    jsonPath: `round-briefs/${id}.json`,
    pdfPath: `round-briefs/${id}.pdf`,
  };

  let updated: Round;
  const pdfAttemptId = randomUUID();
  const pureTrackAttemptId = randomUUID();
  try {
    const result = await withRoundAndBriefLease(id, async (roundLeaseId, briefLeaseId) => {
      const r: Round = await readJson(
        getPrivateBlobClient(path),
        RoundSchema,
        path,
      );

      if (r.status !== "BriefComplete") {
        throw new HttpError(409, "CONFLICT", "Round status changed concurrently");
      }

      const briefPath = `round-briefs/${id}.json`;
      const existing = await readJson(getPrivateBlobClient(briefPath), BriefSchema, briefPath);
      const briefClient = getPrivateBlockBlobClient(briefPath);
      const originalBriefBytes = await briefClient.downloadToBuffer();
      const brief = await mergeBriefForLock(candidateRound, existing);

      // The frozen material hash MUST still match — otherwise the persisted brief
      // was mutated out-of-band since brief-complete. Abort the lock (the round
      // write below never runs, so it stays BriefComplete) with a diagnostic and
      // an operator-actionable message; never a silent failure.
      if (brief.hash === undefined || computeBriefHash(brief) !== brief.hash) {
        getTelemetryClient()?.trackTrace({
          message: "brief.lockHashMismatch",
          properties: { roundId: id },
        });
        throw new HttpError(
          409,
          "BRIEF_HASH_MISMATCH",
          "Brief material no longer matches its frozen sign-to-fly hash — reopen and re-complete the round before locking",
        );
      }

      // Every Filled slot must hold a signature at the current brief version
      // before the round may lock, checked against the leased round `r` and the
      // frozen brief `existing` rather than the candidate.
      //
      // The signing handlers take NO lease — signatures.ts appends to the ledger
      // directly — so a signature can land between this listing and the commit.
      // That is safe because the ledger is append-only: a listing can only miss
      // a new signature, never lose one it saw, so the race yields at worst a
      // spurious 409 that succeeds on retry, and never a lock admitted on
      // signatures this check did not see. The round+brief lease held here does
      // exclude concurrent reopen (`transition` takes the round lease) and brief
      // edits, which is what the hash check above depends on.
      let signatures: Signature[];
      try {
        signatures = await listSignaturesForRound(id);
      } catch {
        // The outer catch turns anything that is not an HttpError into
        // BRIEF_PERSIST_FAILED and tells the operator to reopen and re-complete.
        // Nothing has been persisted yet here, and that advice does not repair an
        // unreadable or malformed ledger, so report the real cause. The
        // underlying error is deliberately not echoed — it can carry storage
        // paths.
        throw new HttpError(
          500,
          "SIGNATURE_LEDGER_UNAVAILABLE",
          "Could not read the sign-to-fly ledger while locking — the round remains BriefComplete; retry once the ledger is readable",
        );
      }
      const unsigned = findUnsignedSlots(r, existing, signatures);
      if (unsigned.length > 0) {
        throw new HttpError(
          409,
          "SIGNATURES_INCOMPLETE",
          `Unsigned slots: ${formatSlotRefs(unsigned)}`,
        );
      }

      // Write the ledger result onto the slots before the round leaves
      // BriefComplete. `slot.signToFly` is materialized asynchronously off the
      // signtofly-reflect queue, so it can still be false here even though every
      // Filled slot is signed — and `reflectRoundSignToFly` early-returns for
      // non-BriefComplete rounds, so a reflect job that lands after this write
      // would be a no-op and the stale false would become permanent. The gate
      // above has already proven the ledger under this same lease, so reuse it.
      materializeSignToFly(r, existing, signatures);

      // Hard failure: if the frozen brief JSON cannot be written, the round must
      // NOT advance to Locked. This write throws on failure, so the round write
      // that follows never runs and the round stays BriefComplete.
      await writePrivateJson(briefPath, BriefSchema, brief, briefLeaseId);

      r.status = "Locked";
      r.isLocked = true;
      r.pureTrack = {
        status: "pending",
        attemptId: pureTrackAttemptId,
        updatedAt: new Date().toISOString(),
      };
      r.pureTrackGroupId = undefined;
      r.pureTrackGroupName = undefined;
      r.pureTrackGroupSlug = undefined;

      for (const team of r.teams) {
        team.pureTrackGroupId = undefined;
        team.pureTrackGroupSlug = undefined;
        for (const slot of team.pilots) {
          if (slot.pilotId && snapshotMap.has(slot.pilotId)) {
            slot.snapshot = snapshotMap.get(slot.pilotId)!;
          }
          slot.accountedFor = false;
        }
      }

      r.brief = {
        version: (r.brief?.version ?? 0) + 1,
        jsonPath: briefPaths.jsonPath,
        pdfPath: briefPaths.pdfPath,
        generatedAt: brief.generatedAt,
        pdfStatus: "pending",
        pdfError: undefined,
        pdfUpdatedAt: new Date().toISOString(),
        pdfAttemptId,
      };

      try {
        await writePrivateJson(path, RoundSchema, r, roundLeaseId);
      } catch (roundWriteError: unknown) {
        await briefClient.upload(originalBriefBytes, originalBriefBytes.length, {
          blobHTTPHeaders: { blobContentType: "application/json" },
          conditions: { leaseId: briefLeaseId },
        }).catch((rollbackError: unknown) => {
          getTelemetryClient()?.trackEvent({
            name: "puretrack.crossBlobReconcileRequired",
            properties: {
              roundId: id,
              operation: "lock",
              roundWriteError:
                roundWriteError instanceof Error ? roundWriteError.name : "unknown",
              rollbackError:
                rollbackError instanceof Error ? rollbackError.name : "unknown",
            },
          });
        });
        throw roundWriteError;
      }
      return { round: r, brief };
    });
    updated = result.round;
  } catch (err: unknown) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(
      500,
      "BRIEF_PERSIST_FAILED",
      "Failed to persist the brief while locking — the round remains BriefComplete; reopen and re-complete before retrying the lock",
    );
  }

  // PDF generation is best-effort AFTER the brief JSON and round are committed: a
  // queue failure leaves the round Locked and marks only the PDF state failed.
  try {
    await enqueueBriefPdf({ roundId: id, briefVersion: updated.brief!.version!, pdfAttemptId });
  } catch {
    // Recovery is best-effort: a failure here must NOT fail the lock or skip updateRoundsIndex.
    await setBriefPdfStatus(id, "failed", { error: "enqueue_failed", expectAttemptId: pdfAttemptId, fromStatuses: ["pending", "processing"] }).catch(() => undefined);
    const recovered = await readJson(getPrivateBlobClient(path), RoundSchema, path).catch(() => undefined);
    if (recovered?.brief !== undefined) updated.brief = recovered.brief;
  }

  try {
    await enqueuePureTrackGroupJob({
      roundId: id,
      attemptId: pureTrackAttemptId,
    });
  } catch {
    await setPureTrackStatus(id, "failed", {
      error: "enqueue_failed",
      expectAttemptId: pureTrackAttemptId,
      fromStatuses: ["pending", "processing"],
    }).catch(() => undefined);
    const recovered = await readJson(getPrivateBlobClient(path), RoundSchema, path).catch(() => undefined);
    if (recovered?.pureTrack !== undefined) updated.pureTrack = recovered.pureTrack;
  }

  await updateRoundsIndex(updated);

  return { status: 200, jsonBody: updated };
}

async function unlockRound(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_ROUND_ID", "Missing round id");

  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isCoord(caller.roles)) return forbiddenResponse();
  await assertManageableRound(caller, id);
  await mutationRateLimit(req, caller, "unlockRound", "standard");

  let updated: Round | undefined;
  await mutatePureTrackEchoes(id, ({ round, brief }) => {
    if (round.status !== "Locked") {
      throw new HttpError(
        409,
        "CONFLICT",
        `Expected status Locked, got ${round.status}`,
      );
    }
    if (round.pureTrack?.status === "pending" || round.pureTrack?.status === "processing") {
      throw new HttpError(
        409,
        "PURETRACK_IN_PROGRESS",
        "PureTrack group creation must finish before unlocking the round",
      );
    }
    round.status = "Confirmed";
    round.pureTrack = undefined;
    round.isLocked = false;
    if (round.brief) {
      round.brief.pdfStatus = undefined;
      round.brief.pdfError = undefined;
      round.brief.pdfAttemptId = undefined;
    }
    // Clear snapshots so they are re-taken at next lock
    for (const team of round.teams) {
      for (const slot of team.pilots) {
        slot.snapshot = null;
      }
    }
    clearPureTrackEchoes(round, brief);
    updated = round;
    return true;
  });
  if (updated === undefined) throw new HttpError(500, "INTERNAL");
  await updateRoundsIndex(updated);
  return { status: 200, jsonBody: updated };
}

// ─── POST /api/rounds/{id}/cancel ─────────────────────────────────────────────

/**
 * Proposed | Confirmed → Cancelled. A cancelled round accepts no field edits;
 * updateRoundsIndex republishes the Cancelled status to the public rounds blob.
 */
async function cancelRound(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  return { status: 200, jsonBody: await applyRoundTransition(req, "cancel") };
}

// ─── POST /api/rounds/{id}/uncancel ───────────────────────────────────────────

/**
 * Cancelled → Proposed. Republishes the restored status to the public blob.
 */
async function uncancelRound(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  return { status: 200, jsonBody: await applyRoundTransition(req, "uncancel") };
}

// ─── POST /api/rounds/{id}/complete ───────────────────────────────────────────
/**
 * Locked → Complete.
 * Runs scoreRound(), sets isLocked = false, then recomputes season derived
 * blobs (league table + results). The recompute is best-effort — the round
 * is already marked Complete before it runs.
 */
async function completeRound(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_ROUND_ID", "Missing round id");

  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isCoord(caller.roles)) return forbiddenResponse();

  const path = `rounds/${id}.json`;
  let current: Round;

  try {
    current = await readJson(getPrivateBlobClient(path), RoundSchema, path);
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Round not found");
    }
    throw new HttpError(500, "INTERNAL");
  }

  assertCanManageRound(caller, current);
  await mutationRateLimit(req, caller, "completeRound", "heavy");

  if (current.status !== "Locked") {
    return {
      status: 409,
      jsonBody: {
        error: `Round must be Locked to complete (currently ${current.status})`,
      },
    };
  }

  let updated: Round;

  try {
    updated = await withPrivateLeaseRenewing(path, async (leaseId) => {
      // Score the LEASED read — NOT a pre-lease snapshot — so a mutation
      // committed between the pre-lease read and lease acquisition can never be
      // stale-overwritten by an outdated score (legacy RoundsController.cs:305-310).
      const r = await readJson(getPrivateBlobClient(path), RoundSchema, path);

      if (r.status !== "Locked") {
        throw new HttpError(
          409,
          "CONFLICT",
          `Round must be Locked to complete (currently ${r.status})`
        );
      }

      // Post-flight safety sweep: every Filled slot must be accounted for before
      // the round may complete. Checked on the leased read `r`, and before any
      // scoring or write, so a firing gate leaves the round untouched at Locked.
      // The Filled/pilotId/noScore rules live in `findUnaccountedSlots`.
      //
      // `updateAccounted` — the only writer of `slot.accountedFor` — takes this
      // same round-blob lease, so no accounting can land between this check and
      // the commit below; unlike lockRound's signature gate there is no ledger
      // lag to reason about.
      const unaccounted = findUnaccountedSlots(r);
      if (unaccounted.length > 0) {
        throw new HttpError(
          409,
          "PILOTS_NOT_ACCOUNTED_FOR",
          `Unaccounted-for slots: ${formatSlotRefs(unaccounted)}`,
        );
      }

      const config = await loadConfig();
      const { round: scored, derivation } = scoreRoundEnforcingValidation(r, config);
      scored.scoring = { scoredAt: new Date().toISOString(), ...derivation };
      scored.status = "Complete";
      scored.isLocked = false;

      await writePrivateJson(path, RoundSchema, scored, leaseId);
      return scored;
    });
  } catch (err: unknown) {
    if (err instanceof HttpError) throw err;
    const e = err as { statusCode?: number };
    if (e.statusCode === 404) throw new HttpError(404, "NOT_FOUND", "Round not found");
    throw new HttpError(500, "INTERNAL");
  }

  // Update index first so public data is immediately correct
  await updateRoundsIndex(updated);

  // Recompute season derived blobs (best-effort — don't fail the response)
  recomputeSeason(updated.season.year).catch((err) => {
    console.error(
      `[completeRound] recomputeSeason(${updated.season.year}) failed:`,
      err
    );
  });

  return { status: 200, jsonBody: updated };
}

// ─── Registration ─────────────────────────────────────────────────────────────

app.http("createRound", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds",
  handler: withErrorHandler(createRound),
});

app.http("updateRound", {
  methods: ["PUT"],
  authLevel: "anonymous",
  route: "rounds/{id}",
  handler: withErrorHandler(updateRound),
});

app.http("confirmRound", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{id}/confirm",
  handler: withErrorHandler(confirmRound),
});

app.http("briefCompleteRound", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{id}/brief-complete",
  handler: withErrorHandler(briefCompleteRound),
});

app.http("reopenBrief", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{id}/reopen",
  handler: withErrorHandler(reopenBrief),
});

app.http("lockRound", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{id}/lock",
  handler: withErrorHandler(lockRound),
});

app.http("unlockRound", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{id}/unlock",
  handler: withErrorHandler(unlockRound),
});

app.http("cancelRound", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{id}/cancel",
  handler: withErrorHandler(cancelRound),
});

app.http("uncancelRound", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{id}/uncancel",
  handler: withErrorHandler(uncancelRound),
});

app.http("completeRound", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{id}/complete",
  handler: withErrorHandler(completeRound),
});
