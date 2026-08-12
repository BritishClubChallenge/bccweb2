// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { createHash } from "crypto";
import type { Club, ClubTeam, ClubTeamSummary, Config, Round, SeasonClub } from "@bccweb/types";
import {
  ClubSchema,
  ClubTeamSchema,
  ClubTeamSummarySchema,
  ConfigSchema,
  RoundSchema,
  RoundSummarySchema,
  SeasonClubSchema,
} from "@bccweb/schemas";
import * as z from "zod/v4";
import {
  getBlobClient,
  getPrivateBlobClient,
  getPrivateBlockBlobClient,
  withPrivateLeaseRenewing,
} from "../lib/blob.js";
import { readJson, writeJson, writePrivateJson } from "../lib/blobJson.js";
import {
  forbiddenResponse,
  getCallerIdentity,
  unauthorizedResponse,
} from "../lib/auth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";
import { mutationRateLimit } from "../lib/rateLimit.js";
import { getBlobServiceClient } from "../lib/storageClients.js";

interface SeasonClubIndexEntry {
  id: string;
  seasonYear: number;
  clubId: string;
  clubName: string;
  numTeams: number;
  acceptedTsCs: boolean;
  acceptedTsCsAt?: string;
}

// SeasonClubIndexEntry is a denormalised view local to this module — no schema
// in @bccweb/schemas. Defined inline as a strict superset of every field the
// writer (toIndexEntry) emits so observe-mode logs are clean.
const SeasonClubIndexEntrySchema = z
  .object({
    id: z.string().min(1),
    seasonYear: z.number().int(),
    clubId: z.string().min(1),
    clubName: z.string().min(1),
    numTeams: z.number().int(),
    acceptedTsCs: z.boolean(),
    acceptedTsCsAt: z.string().min(1).optional(),
  })
  .strip();

SeasonClubIndexEntrySchema satisfies z.ZodType<SeasonClubIndexEntry>;

const SeasonClubIndexSchema = z.array(SeasonClubIndexEntrySchema);
const ClubTeamsIndexSchema = z.array(ClubTeamSummarySchema);
const RoundsIndexSchema = z.array(RoundSummarySchema);

interface CreateSeasonClubBody {
  clubId?: string;
  numTeams?: number;
  acceptTsCs?: boolean;
  acceptedBy?: string;
}

interface UpdateSeasonClubBody {
  numTeams?: number;
  acceptedTsCs?: boolean;
}

function getPrivateContainer() {
  const containerName = process.env["BLOB_PRIVATE_CONTAINER_NAME"] ?? "data-private";
  return getBlobServiceClient().getContainerClient(containerName);
}

function parseYear(req: HttpRequest): number {
  const raw = req.params["year"];
  const year = Number.parseInt(raw ?? "", 10);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new HttpError(400, "INVALID_YEAR", "Invalid season year");
  }
  return year;
}

function isAdmin(roles: string[]): boolean {
  return roles.includes("Admin");
}

function isAdminOrScopedCoord(roles: string[], callerClubId: string | null, clubId: string): boolean {
  return isAdmin(roles) || (roles.includes("RoundsCoord") && callerClubId === clubId);
}

function stableUuid(entity: string, key: string): string {
  const hex = createHash("sha256").update(`${entity}:${key}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0")}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

function teamSuffix(index: number): string {
  let n = index + 1;
  let suffix = "";
  while (n > 0) {
    n -= 1;
    suffix = String.fromCharCode(65 + (n % 26)) + suffix;
    n = Math.floor(n / 26);
  }
  return suffix;
}

async function readConfig(): Promise<Config> {
  try {
    return await readJson(
      getPrivateBlobClient("config.json"),
      ConfigSchema,
      "config.json",
    );
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return ConfigSchema.parse({});
    }
    throw err;
  }
}

async function readClub(clubId: string): Promise<Club> {
  try {
    return await readJson(
      getPrivateBlobClient(`clubs/${clubId}.json`),
      ClubSchema,
      `clubs/${clubId}.json`,
    );
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(400, "INVALID_CLUB", "clubId does not exist");
    }
    throw new HttpError(500, "INTERNAL");
  }
}

async function ensurePrivateSentinel(path: string): Promise<void> {
  const client = getPrivateBlockBlobClient(path);
  const content = JSON.stringify({ purpose: "season-club-lock" });
  try {
    await client.upload(content, Buffer.byteLength(content), {
      blobHTTPHeaders: { blobContentType: "application/json" },
      conditions: { ifNoneMatch: "*" },
    });
  } catch (err: unknown) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status !== 409 && status !== 412) throw err;
  }
}

async function readIndex(year: number): Promise<SeasonClubIndexEntry[]> {
  try {
    return await readJson(
      getBlobClient(`season-clubs/${year}/index.json`),
      SeasonClubIndexSchema,
      `season-clubs/${year}/index.json`,
    );
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) return [];
    throw err;
  }
}

async function writeIndex(year: number, index: SeasonClubIndexEntry[]): Promise<void> {
  index.sort((a, b) => a.clubName.localeCompare(b.clubName));
  await writeJson(`season-clubs/${year}/index.json`, SeasonClubIndexSchema, index);
}

async function readSeasonClub(year: number, clubIdOrSeasonClubId: string): Promise<SeasonClub> {
  const byClubPath = `season-clubs/${year}/${clubIdOrSeasonClubId}.json`;
  try {
    return await readJson(
      getPrivateBlobClient(byClubPath),
      SeasonClubSchema,
      byClubPath,
    );
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode !== 404) throw err;
  }

  const index = await readIndex(year);
  const entry = index.find((item) => item.id === clubIdOrSeasonClubId);
  if (!entry) throw new HttpError(404, "NOT_FOUND", "Season club not found");
  const fallbackPath = `season-clubs/${year}/${entry.clubId}.json`;
  try {
    return await readJson(
      getPrivateBlobClient(fallbackPath),
      SeasonClubSchema,
      fallbackPath,
    );
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Season club not found");
    }
    throw err;
  }
}

async function listSeasonClubs(year: number): Promise<SeasonClub[]> {
  const index = await readIndex(year);
  if (index.length > 0) {
    const docs = await Promise.all(index.map((entry) => readSeasonClub(year, entry.clubId).catch(() => null)));
    return docs.filter((doc): doc is SeasonClub => doc !== null);
  }

  const docs: SeasonClub[] = [];
  const prefix = `season-clubs/${year}/`;
  for await (const item of getPrivateContainer().listBlobsFlat({ prefix })) {
    if (!item.name.endsWith(".json") || item.name.endsWith("index.json")) continue;
    docs.push(
      await readJson(
        getPrivateBlobClient(item.name),
        SeasonClubSchema,
        item.name,
      ),
    );
  }
  docs.sort((a, b) => (a.clubId === b.clubId ? a.id.localeCompare(b.id) : a.clubId.localeCompare(b.clubId)));
  return docs;
}

function toIndexEntry(seasonClub: SeasonClub, clubName: string): SeasonClubIndexEntry {
  return {
    id: seasonClub.id,
    seasonYear: seasonClub.seasonYear,
    clubId: seasonClub.clubId,
    clubName,
    numTeams: seasonClub.numTeams,
    acceptedTsCs: seasonClub.acceptedTsCs,
    ...(seasonClub.acceptedTsCsAt ? { acceptedTsCsAt: seasonClub.acceptedTsCsAt } : {}),
  };
}

async function upsertIndexEntry(year: number, entry: SeasonClubIndexEntry): Promise<void> {
  const index = await readIndex(year);
  const existing = index.findIndex((item) => item.id === entry.id || item.clubId === entry.clubId);
  if (existing >= 0) index[existing] = entry;
  else index.push(entry);
  await writeIndex(year, index);
}

async function removeIndexEntry(year: number, seasonClubId: string): Promise<void> {
  const index = await readIndex(year);
  await writeIndex(year, index.filter((item) => item.id !== seasonClubId));
}

async function readClubTeamIndex(): Promise<ClubTeamSummary[]> {
  try {
    return await readJson(
      getBlobClient("club-teams.json"),
      ClubTeamsIndexSchema,
      "club-teams.json",
    );
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) return [];
    throw err;
  }
}

async function writeClubTeamIndex(index: ClubTeamSummary[]): Promise<void> {
  index.sort((a, b) => {
    if (b.seasonYear !== a.seasonYear) return b.seasonYear - a.seasonYear;
    if (a.clubName !== b.clubName) return a.clubName.localeCompare(b.clubName);
    return a.teamName.localeCompare(b.teamName);
  });
  await writeJson("club-teams.json", ClubTeamsIndexSchema, index);
}

function clubTeamPath(year: number, clubId: string, teamNumber: number): string {
  return `club-teams/${year}/${clubId}/team-${teamNumber}.json`;
}

function makeClubTeam(year: number, club: Club, teamNumber: number): ClubTeam {
  const id = stableUuid("club-team", `${year}-${club.id}-team-${teamNumber}`);
  return {
    id,
    clubId: club.id,
    clubName: club.name,
    seasonYear: year,
    teamName: `${club.name} ${teamSuffix(teamNumber - 1)}`,
    createdAt: new Date().toISOString(),
  };
}

async function writeTeams(year: number, club: Club, count: number): Promise<ClubTeam[]> {
  const teams = Array.from({ length: count }, (_, i) => makeClubTeam(year, club, i + 1));
  const index = (await readClubTeamIndex()).filter((team) => !(team.seasonYear === year && team.clubId === club.id));
  for (const team of teams) {
    await writePrivateJson(
      clubTeamPath(year, club.id, teams.indexOf(team) + 1),
      ClubTeamSchema,
      team,
    );
    index.push({
      id: team.id,
      clubId: team.clubId,
      clubName: team.clubName,
      seasonYear: team.seasonYear,
      teamName: team.teamName,
    });
  }
  await writeClubTeamIndex(index);
  return teams;
}

async function deleteTeams(year: number, clubId: string, from: number, to: number): Promise<void> {
  for (let teamNumber = from; teamNumber <= to; teamNumber += 1) {
    await getPrivateBlockBlobClient(clubTeamPath(year, clubId, teamNumber)).deleteIfExists();
  }
  const index = (await readClubTeamIndex()).filter((team) => {
    if (team.seasonYear !== year || team.clubId !== clubId) return true;
    const suffix = team.teamName.trim().split(/\s+/).at(-1);
    const number = suffix ? suffix.charCodeAt(0) - 64 : 0;
    return number < from || number > to;
  });
  await writeClubTeamIndex(index);
}

async function hasRoundAssignments(year: number, clubId: string): Promise<boolean> {
  let rounds: Array<{ id: string; seasonYear: number }> = [];
  try {
    // rounds.json is the public RoundSummary[] index; we only need id + seasonYear.
    const summaries = await readJson(
      getBlobClient("rounds.json"),
      RoundsIndexSchema,
      "rounds.json",
    );
    rounds = summaries.map((summary) => ({ id: summary.id, seasonYear: summary.seasonYear }));
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) return false;
    throw err;
  }
  for (const summary of rounds.filter((round) => round.seasonYear === year)) {
    try {
      const round: Round = await readJson(
        getPrivateBlobClient(`rounds/${summary.id}.json`),
        RoundSchema,
        `rounds/${summary.id}.json`,
      );
      if (round.teams.some((team) => team.club.id === clubId)) return true;
    } catch {
    }
  }
  return false;
}

async function getSeasonClubs(req: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!caller.roles.includes("Admin") && !caller.roles.includes("RoundsCoord")) return forbiddenResponse();
  const year = parseYear(req);
  const docs = await listSeasonClubs(year);
  const visible = isAdmin(caller.roles) ? docs : docs.filter((doc) => doc.clubId === caller.clubId);
  return { status: 200, jsonBody: visible };
}

async function createSeasonClub(req: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isAdmin(caller.roles)) return forbiddenResponse();
  await mutationRateLimit(req, caller, "createSeasonClub", "standard");
  const year = parseYear(req);

  let body: CreateSeasonClubBody;
  try {
    body = (await req.json()) as CreateSeasonClubBody;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON");
  }
  if (!body.clubId?.trim()) throw new HttpError(400, "INVALID_BODY", "clubId is required");
  if (!body.acceptTsCs) throw new HttpError(400, "TCS_REQUIRED", "acceptTsCs must be true");

  const config = await readConfig();
  if (!Number.isInteger(body.numTeams) || body.numTeams! < 1 || body.numTeams! > config.maxTeamsInClub) {
    throw new HttpError(400, "INVALID_NUM_TEAMS", `numTeams must be between 1 and ${config.maxTeamsInClub}`);
  }
  const club = await readClub(body.clubId.trim());
  const lockPath = `season-clubs/${year}/index.json.lock`;
  await ensurePrivateSentinel(lockPath);

  return withPrivateLeaseRenewing(lockPath, async () => {
    const existing = await listSeasonClubs(year);
    if (existing.some((doc) => doc.clubId === club.id)) {
      throw new HttpError(409, "ALREADY_REGISTERED", "Club is already registered for this season");
    }
    const now = new Date().toISOString();
    const seasonClub: SeasonClub = {
      id: stableUuid("season-club", `${year}-${club.id}`),
      seasonYear: year,
      clubId: club.id,
      numTeams: body.numTeams!,
      acceptedTsCs: true,
      acceptedTsCsAt: now,
      acceptedTsCsBy: body.acceptedBy?.trim() || caller.email || caller.userId,
      createdAt: now,
      updatedAt: now,
      updatedBy: caller.userId,
    };
    await writePrivateJson(
      `season-clubs/${year}/${club.id}.json`,
      SeasonClubSchema,
      seasonClub,
    );
    const teams = await writeTeams(year, club, body.numTeams!);
    await upsertIndexEntry(year, toIndexEntry(seasonClub, club.name));
    return { status: 201, jsonBody: { seasonClub, teams } };
  }, { renewIntervalMs: 10_000 });
}

async function updateSeasonClub(req: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isAdmin(caller.roles)) return forbiddenResponse();
  await mutationRateLimit(req, caller, "updateSeasonClub", "standard");
  const year = parseYear(req);
  const seasonClubId = req.params["seasonClubId"];
  if (!seasonClubId) throw new HttpError(400, "MISSING_SEASON_CLUB_ID", "Missing season club id");

  let body: UpdateSeasonClubBody;
  try {
    body = (await req.json()) as UpdateSeasonClubBody;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON");
  }

  const config = await readConfig();
  if (body.numTeams !== undefined && (!Number.isInteger(body.numTeams) || body.numTeams < 1 || body.numTeams > config.maxTeamsInClub)) {
    throw new HttpError(400, "INVALID_NUM_TEAMS", `numTeams must be between 1 and ${config.maxTeamsInClub}`);
  }
  const lockPath = `season-clubs/${year}/index.json.lock`;
  await ensurePrivateSentinel(lockPath);

  return withPrivateLeaseRenewing(lockPath, async () => {
    const existing = await readSeasonClub(year, seasonClubId);
    const club = await readClub(existing.clubId);
    const nextNumTeams = body.numTeams ?? existing.numTeams;
    if (nextNumTeams < existing.numTeams && await hasRoundAssignments(year, existing.clubId)) {
      throw new HttpError(409, "IN_USE_BY_ROUND", "Cannot shrink teams after round registration");
    }
    const updated: SeasonClub = {
      ...existing,
      numTeams: nextNumTeams,
      ...(body.acceptedTsCs !== undefined ? { acceptedTsCs: body.acceptedTsCs } : {}),
      updatedAt: new Date().toISOString(),
      updatedBy: caller.userId,
    };

    await writePrivateJson(
      `season-clubs/${year}/${existing.clubId}.json`,
      SeasonClubSchema,
      updated,
    );
    if (nextNumTeams > existing.numTeams) {
      await writeTeams(year, club, nextNumTeams);
    } else if (nextNumTeams < existing.numTeams) {
      await deleteTeams(year, existing.clubId, nextNumTeams + 1, existing.numTeams);
    }
    await upsertIndexEntry(year, toIndexEntry(updated, club.name));
    return { status: 200, jsonBody: updated };
  }, { renewIntervalMs: 10_000 });
}

async function deleteSeasonClub(req: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isAdmin(caller.roles)) return forbiddenResponse();
  await mutationRateLimit(req, caller, "deleteSeasonClub", "standard");
  const year = parseYear(req);
  const seasonClubId = req.params["seasonClubId"];
  if (!seasonClubId) throw new HttpError(400, "MISSING_SEASON_CLUB_ID", "Missing season club id");
  const lockPath = `season-clubs/${year}/index.json.lock`;
  await ensurePrivateSentinel(lockPath);

  return withPrivateLeaseRenewing(lockPath, async () => {
    const existing = await readSeasonClub(year, seasonClubId);
    if (!isAdminOrScopedCoord(caller.roles, caller.clubId, existing.clubId)) return forbiddenResponse();
    if (await hasRoundAssignments(year, existing.clubId)) {
      throw new HttpError(409, "IN_USE_BY_ROUND", "Club teams are already registered for a round");
    }
    await getPrivateBlockBlobClient(`season-clubs/${year}/${existing.clubId}.json`).deleteIfExists();
    await deleteTeams(year, existing.clubId, 1, existing.numTeams);
    await removeIndexEntry(year, existing.id);
    return { status: 200, jsonBody: { id: existing.id } };
  }, { renewIntervalMs: 10_000 });
}

app.http("getSeasonClubs", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "manage/seasons/{year}/clubs",
  handler: withErrorHandler(getSeasonClubs),
});

app.http("createSeasonClub", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "manage/seasons/{year}/clubs",
  handler: withErrorHandler(createSeasonClub),
});

app.http("updateSeasonClub", {
  methods: ["PUT"],
  authLevel: "anonymous",
  route: "manage/seasons/{year}/clubs/{seasonClubId}",
  handler: withErrorHandler(updateSeasonClub),
});

app.http("deleteSeasonClub", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "manage/seasons/{year}/clubs/{seasonClubId}",
  handler: withErrorHandler(deleteSeasonClub),
});
