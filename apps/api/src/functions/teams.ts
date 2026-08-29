// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * Team & pilot management endpoints — Phase 3
 *
 * POST   /api/rounds/{id}/teams                                    — add team
 * DELETE /api/rounds/{id}/teams/{teamId}                          — remove team
 * POST   /api/rounds/{id}/teams/{teamId}/pilots                   — add pilot to team
 * DELETE /api/rounds/{id}/teams/{teamId}/pilots/{place}           — remove pilot slot
 * PUT    /api/rounds/{id}/teams/{teamId}/pilots/{place}/accounted  — toggle accounted-for
 */

import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { randomUUID } from "crypto";
import type { CallerIdentity, ClubTeamSummary, Config, Pilot, Round, Team, PilotSlot } from "@bccweb/types";
import { isRosterFrozen, rosterFrozenReason } from "@bccweb/types";
import { ClubTeamSummarySchema, ConfigSchema, PilotSchema, RoundSchema } from "@bccweb/schemas";
import * as z from "zod/v4";
import { getBlobClient, getPrivateBlobClient, withPrivateLease } from "../lib/blob.js";
import { readJson, writePrivateJson } from "../lib/blobJson.js";

const ClubTeamSummariesSchema = z.array(ClubTeamSummarySchema);
import {
  getCallerIdentity,
  unauthorizedResponse,
  forbiddenResponse,
} from "../lib/auth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";
import {
  assertCanAccountForSlot,
  assertCanManageRound,
  assertCanRegisterForClub,
  isCoord,
} from "../lib/roundAuth.js";
import { mutationRateLimit } from "../lib/rateLimit.js";
import { recomputeTeamCaptain } from "../lib/teamCaptain.js";
import { ensureSeasonClubRecorded, pilotClubIdForSeason } from "../lib/pilotClub.js";
import { choosePlace } from "./roundRegistration.js";

// ─── Auth helper ──────────────────────────────────────────────────────────────

async function loadRound(id: string): Promise<Round> {
  const path = `rounds/${id}.json`;
  try {
    return await readJson(getPrivateBlobClient(path), RoundSchema, path);
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Round not found");
    }
    throw new HttpError(500, "INTERNAL");
  }
}

async function loadConfig(): Promise<Config> {
  try {
    return await readJson(getPrivateBlobClient("config.json"), ConfigSchema, "config.json");
  } catch {
    return ConfigSchema.parse({});
  }
}

function authorizeTeamRegistration(
  caller: CallerIdentity,
  round: Round,
  teamId: string,
): void {
  const team = round.teams.find((t) => t.id === teamId);
  if (!team) throw new HttpError(404, "TEAM_NOT_FOUND", "Team not found");
  assertCanRegisterForClub(caller, round, team.club.id);
}

// ─── Generic round mutator ────────────────────────────────────────────────────

/**
 * Acquire a lease on the round blob, load it, apply `mutateFn`, and write
 * back. Returns the updated round or an HttpResponseInit error.
 */
async function mutateLocked(
  id: string,
  caller: CallerIdentity,
  mutateFn: (round: Round) => void | string,
  authorize: (round: Round) => void = (r) => assertCanManageRound(caller, r),
): Promise<Round | HttpResponseInit> {
  const path = `rounds/${id}.json`;

  try {
    return await withPrivateLease(path, async (leaseId) => {
      const r = await readJson(getPrivateBlobClient(path), RoundSchema, path);
      authorize(r);
      const err = mutateFn(r);
      if (err) {
        throw new HttpError(409, "CONFLICT", err);
      }
      await writePrivateJson(path, RoundSchema, r, leaseId);
      return r;
    });
  } catch (e: unknown) {
    if (e instanceof HttpError) throw e;
    const err = e as { statusCode?: number };
    if (err.statusCode === 404) throw new HttpError(404, "NOT_FOUND", "Round not found");
    throw new HttpError(500, "INTERNAL");
  }
}

// ─── POST /api/rounds/{id}/teams ──────────────────────────────────────────────

async function addTeam(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isCoord(caller.roles)) return forbiddenResponse();

  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_ROUND_ID", "Missing round id");

  const round = await loadRound(id);
  await mutationRateLimit(req, caller, "addTeam", "standard");

  const body = (await req.json()) as { clubId?: string; teamName?: string };
  if (!body.clubId || !body.teamName?.trim()) {
    throw new HttpError(400, "INVALID_BODY", "clubId and teamName are required");
  }

  // teamName must match a ClubTeam pre-registered for (clubId, seasonYear); canonical name + clubName come from the matched entry.
  let clubTeams: ClubTeamSummary[] = [];
  try {
    clubTeams = await readJson(
      getBlobClient("club-teams.json"),
      ClubTeamSummariesSchema,
      "club-teams.json",
    );
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode !== 404) throw err;
  }
  const submitted = body.teamName.trim().toLowerCase();
  const matched = clubTeams.find(
    (t) =>
      t.clubId === body.clubId &&
      t.seasonYear === round.season.year &&
      t.teamName.trim().toLowerCase() === submitted
  );
  if (!matched) {
    throw new HttpError(
      400,
      "UNKNOWN_TEAM_NAME",
      `No team "${body.teamName}" is registered for this club in the ${round.season.year} season. Register it under Club Teams first.`
    );
  }

  assertCanRegisterForClub(caller, round, matched.clubId);

  const newTeam: Team = {
    id: randomUUID(),
    teamName: matched.teamName,
    club: { id: matched.clubId, name: matched.clubName },
    score: 0,
    pilots: [],
  };

  const result = await mutateLocked(id, caller, (r) => {
    if (isRosterFrozen(r.status)) return `Cannot change teams or pilots while ${rosterFrozenReason(r.status)}`;
    if (r.teams.length >= r.maxTeams) {
      return `Round is full (max ${r.maxTeams} teams)`;
    }
    if (
      r.teams.some(
        (t) => t.teamName === newTeam.teamName && t.club.id === newTeam.club.id
      )
    ) {
      return "A team with that name from that club already exists in this round";
    }
    r.teams.push(newTeam);
  }, (r) => assertCanRegisterForClub(caller, r, matched.clubId));

  if (typeof (result as HttpResponseInit).status === "number") return result as HttpResponseInit;
  return { status: 200, jsonBody: result };
}

// ─── DELETE /api/rounds/{id}/teams/{teamId} ───────────────────────────────────

async function removeTeam(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isCoord(caller.roles)) return forbiddenResponse();

  const { id, teamId } = req.params as { id?: string; teamId?: string };
  if (!id || !teamId) {
    throw new HttpError(400, "MISSING_IDS", "Missing round or team id");
  }

  const round = await loadRound(id);
  authorizeTeamRegistration(caller, round, teamId);
  await mutationRateLimit(req, caller, "removeTeam", "standard");

  const result = await mutateLocked(id, caller, (r) => {
    if (isRosterFrozen(r.status)) return `Cannot change teams or pilots while ${rosterFrozenReason(r.status)}`;
    const idx = r.teams.findIndex((t) => t.id === teamId);
    if (idx === -1) return "Team not found";
    r.teams.splice(idx, 1);
  }, (r) => authorizeTeamRegistration(caller, r, teamId));

  if (typeof (result as HttpResponseInit).status === "number") return result as HttpResponseInit;
  return { status: 200, jsonBody: result };
}

// ─── POST /api/rounds/{id}/teams/{teamId}/pilots ──────────────────────────────

async function addPilot(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isCoord(caller.roles)) return forbiddenResponse();

  const { id, teamId } = req.params as { id?: string; teamId?: string };
  if (!id || !teamId) {
    throw new HttpError(400, "MISSING_IDS", "Missing round or team id");
  }

  const round = await loadRound(id);
  authorizeTeamRegistration(caller, round, teamId);
  await mutationRateLimit(req, caller, "addPilot", "standard");

  const body = (await req.json()) as {
    pilotId?: string;
  };
  if (!body.pilotId) {
    throw new HttpError(400, "INVALID_BODY", "pilotId is required");
  }

  let pilot: Pilot;
  const pilotPath = `pilots/${body.pilotId}.json`;
  try {
    pilot = await readJson(getPrivateBlobClient(pilotPath), PilotSchema, pilotPath);
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(400, "INVALID_BODY", "Pilot not found");
    }
    throw new HttpError(500, "INTERNAL");
  }

  const team = round.teams.find((t) => t.id === teamId);
  if (!team) throw new HttpError(404, "TEAM_NOT_FOUND", "Team not found");

  if (isRosterFrozen(round.status)) {
    throw new HttpError(409, "CONFLICT", `Cannot change teams or pilots while ${rosterFrozenReason(round.status)}`);
  }

  const pilotClubId = pilotClubIdForSeason(pilot, round.season.year);
  if (!pilotClubId) {
    throw new HttpError(422, "NO_CLUB_FOR_SEASON", "This pilot has no club for this season.");
  }
  if (pilotClubId !== team.club.id) {
    throw new HttpError(422, "TEAM_CLUB_MISMATCH", "This pilot does not belong to this team's club for this season.");
  }

  const effectiveClubId = await ensureSeasonClubRecorded(pilot.id, round.season.year, pilotClubId, team.club.name);
  if (effectiveClubId !== team.club.id) {
    throw new HttpError(422, "TEAM_CLUB_MISMATCH", "This pilot does not belong to this team's club for this season.");
  }

  const config = await loadConfig();

  const result = await mutateLocked(id, caller, (r) => {
    if (isRosterFrozen(r.status)) return `Cannot change teams or pilots while ${rosterFrozenReason(r.status)}`;

    const teamIdx = r.teams.findIndex((t) => t.id === teamId);
    if (teamIdx === -1) return "Team not found";
    const team = r.teams[teamIdx];

    // Pilot may not be registered more than once in the same round
    const alreadyRegistered = r.teams.some((t) =>
      t.pilots.some((s) => s.pilotId === body.pilotId && s.status === "Filled")
    );
    if (alreadyRegistered) {
      return "Pilot is already registered in this round";
    }

    // D11 — positional slot eligibility fixed at creation: `choosePlace` (shared
    // with self-registration) gives the first free place, so re-adding after a
    // removePilot splice reuses the freed place rather than growing past the cap.
    // No reorder/override path in this plan (legacy RoundTeam.cs:41-55).
    const place = choosePlace(team, undefined, config.maxPilotsInTeam);

    const slot: PilotSlot = {
      placeInTeam: place,
      isScoring: place <= config.maxScoringPilotsInTeam,
      status: "Filled",
      accountedFor: false,
      signToFly: false,
      noScore: false,
      pilotPoints: 0,
      pilotId: body.pilotId!,
      snapshot: null,
      flight: null,
    };

    team.pilots.push(slot);
    r.teams[teamIdx] = recomputeTeamCaptain(team);
  }, (r) => authorizeTeamRegistration(caller, r, teamId));

  if (typeof (result as HttpResponseInit).status === "number") return result as HttpResponseInit;
  return { status: 200, jsonBody: result };
}

// ─── DELETE /api/rounds/{id}/teams/{teamId}/pilots/{place} ────────────────────

async function removePilot(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isCoord(caller.roles)) return forbiddenResponse();

  const { id, teamId, place } = req.params as {
    id?: string;
    teamId?: string;
    place?: string;
  };
  if (!id || !teamId || !place) {
    throw new HttpError(400, "MISSING_IDS", "Missing round, team, or place");
  }

  const round = await loadRound(id);
  authorizeTeamRegistration(caller, round, teamId);
  await mutationRateLimit(req, caller, "removePilot", "standard");

  const placeNum = Number(place);
  if (!Number.isInteger(placeNum)) {
    throw new HttpError(400, "INVALID_PLACE", "place must be a number");
  }

  const result = await mutateLocked(id, caller, (r) => {
    if (isRosterFrozen(r.status)) return `Cannot change teams or pilots while ${rosterFrozenReason(r.status)}`;

    const teamIdx = r.teams.findIndex((t) => t.id === teamId);
    if (teamIdx === -1) return "Team not found";
    const team = r.teams[teamIdx];

    const idx = team.pilots.findIndex((s) => s.placeInTeam === placeNum);
    if (idx === -1) return "Pilot slot not found";

    team.pilots.splice(idx, 1);
    r.teams[teamIdx] = recomputeTeamCaptain(team);
  }, (r) => authorizeTeamRegistration(caller, r, teamId));

  if (typeof (result as HttpResponseInit).status === "number") return result as HttpResponseInit;
  return { status: 200, jsonBody: result };
}

// ─── PUT /api/rounds/{id}/teams/{teamId}/pilots/{place}/accounted ─────────────

async function updateAccounted(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();

  const { id, teamId, place } = req.params as {
    id?: string;
    teamId?: string;
    place?: string;
  };
  if (!id || !teamId || !place) {
    throw new HttpError(400, "MISSING_IDS", "Missing round, team, or place");
  }

  const body = (await req.json()) as { accountedFor?: boolean };
  if (typeof body.accountedFor !== "boolean") {
    throw new HttpError(400, "INVALID_BODY", "accountedFor (boolean) is required");
  }

  const placeNum = Number(place);
  if (!Number.isInteger(placeNum)) {
    throw new HttpError(400, "INVALID_PLACE", "place must be a number");
  }

  const authorizeSlot = (r: Round): void => {
    const team = r.teams.find((t) => t.id === teamId);
    if (!team) throw new HttpError(404, "TEAM_NOT_FOUND", "Team not found");
    const slot = team.pilots.find((s) => s.placeInTeam === placeNum);
    if (!slot) throw new HttpError(404, "SLOT_NOT_FOUND", "Pilot slot not found");
    assertCanAccountForSlot(caller, r, team, slot);
  };

  authorizeSlot(await loadRound(id));
  await mutationRateLimit(req, caller, "updateAccounted", "standard");

  const result = await mutateLocked(
    id,
    caller,
    (r) => {
      if (r.status !== "Locked") {
        return `Accounted-for can only be changed while the round is Locked (currently ${r.status})`;
      }
      const team = r.teams.find((t) => t.id === teamId);
      if (!team) return "Team not found";

      const slot = team.pilots.find((s) => s.placeInTeam === placeNum);
      if (!slot) return "Pilot slot not found";
      if (slot.status !== "Filled") {
        throw new HttpError(409, "SLOT_EMPTY", "Cannot account for an empty slot");
      }

      slot.accountedFor = body.accountedFor!;
    },
    authorizeSlot,
  );

  if (typeof (result as HttpResponseInit).status === "number") return result as HttpResponseInit;
  return { status: 200, jsonBody: result };
}

// ─── Registration ─────────────────────────────────────────────────────────────

app.http("addTeam", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{id}/teams",
  handler: withErrorHandler(addTeam),
});

app.http("removeTeam", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "rounds/{id}/teams/{teamId}",
  handler: withErrorHandler(removeTeam),
});

app.http("addPilot", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "rounds/{id}/teams/{teamId}/pilots",
  handler: withErrorHandler(addPilot),
});

app.http("removePilot", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "rounds/{id}/teams/{teamId}/pilots/{place}",
  handler: withErrorHandler(removePilot),
});

app.http("updateAccounted", {
  methods: ["PUT"],
  authLevel: "anonymous",
  route: "rounds/{id}/teams/{teamId}/pilots/{place}/accounted",
  handler: withErrorHandler(updateAccounted),
});
