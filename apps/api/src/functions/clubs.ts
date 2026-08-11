// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { randomUUID } from "crypto";
import type { Club, ClubSummary } from "@bccweb/types";
import { ClubSchema, ClubSummarySchema, ClubTeamSummarySchema, SeasonClubSchema, SeasonSummarySchema, SiteSummarySchema } from "@bccweb/schemas";
import * as z from "zod/v4";
import { ensureJsonIndexBlob, getBlobClient, getPrivateBlobClient, withLeaseRetry, withPrivateLeaseRetry } from "../lib/blob.js";
import { readJson, writeJson, writePrivateJson } from "../lib/blobJson.js";
import {
  getCallerIdentity,
  unauthorizedResponse,
  forbiddenResponse,
} from "../lib/auth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";
import { mutationRateLimit } from "../lib/rateLimit.js";
import { getBlobServiceClient } from "../lib/storageClients.js";

const ClubsIndexSchema = z.array(ClubSummarySchema);
const ClubTeamsIndexSchema = z.array(ClubTeamSummarySchema);
const SitesIndexSchema = z.array(SiteSummarySchema);
const SeasonsIndexSchema = z.array(SeasonSummarySchema);

const SeasonClubIndexSchema = z.array(z
  .object({
    id: z.string().min(1),
    seasonYear: z.number().int(),
    clubId: z.string().min(1),
    clubName: z.string().min(1),
    numTeams: z.number().int(),
    acceptedTsCs: z.boolean(),
    acceptedTsCsAt: z.string().min(1).optional(),
  })
  .strip());

interface ClubPatch {
  readonly name?: string;
  readonly sites?: string[];
}

function getPrivateContainer() {
  const containerName = process.env["BLOB_PRIVATE_CONTAINER_NAME"] ?? "data-private";
  return getBlobServiceClient().getContainerClient(containerName);
}

// ─── GET /api/clubs ───────────────────────────────────────────────────────────

async function getClubs(
  _req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  try {
    const clubs = await readJson(
      getBlobClient("clubs.json"),
      ClubsIndexSchema,
      "clubs.json",
    );
    clubs.sort((a, b) => a.name.localeCompare(b.name));
    return { status: 200, jsonBody: clubs };
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return { status: 200, jsonBody: [] };
    }
    throw new HttpError(500, "INTERNAL");
  }
}

// ─── POST /api/clubs ──────────────────────────────────────────────────────────

async function createClub(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!caller.roles.includes("Admin")) return forbiddenResponse();
  await mutationRateLimit(req, caller, "createClub", "standard");

  let body: { name?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON");
  }

  if (!body.name?.trim()) {
    throw new HttpError(400, "INVALID_BODY", "name is required");
  }

  const id = randomUUID();
  const club: Club = {
    id,
    name: body.name.trim(),
    sites: [],
    teams: [],
  };

  await writePrivateJson(`clubs/${id}.json`, ClubSchema, club);
  await upsertClubInIndex({ id, name: club.name });

  return { status: 201, jsonBody: club };
}

// ─── PUT /api/clubs/{id} ──────────────────────────────────────────────────────

async function updateClub(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!caller.roles.includes("Admin")) return forbiddenResponse();
  await mutationRateLimit(req, caller, "updateClub", "standard");

  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_CLUB_ID", "Missing club id");

  let body: ClubPatch;
  try {
    body = (await req.json()) as ClubPatch;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON");
  }

  let updated: Club;
  try {
    updated = await withPrivateLeaseRetry(`clubs/${id}.json`, async (leaseId) => {
      const existing = await readJson(
        getPrivateBlobClient(`clubs/${id}.json`),
        ClubSchema,
        `clubs/${id}.json`,
      );
      const next: Club = {
        ...existing,
        name: body.name?.trim() ?? existing.name,
        sites: body.sites ?? existing.sites,
        id: existing.id, // immutable
      };
      await writePrivateJson(`clubs/${id}.json`, ClubSchema, next, leaseId);
      return next;
    });
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Club not found");
    }
    throw new HttpError(500, "INTERNAL");
  }
  await upsertClubInIndex({ id, name: updated.name }, false);

  return { status: 200, jsonBody: updated };
}

// ─── DELETE /api/clubs/{id} ────────────────────────────────────────────────────

async function deleteClub(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!caller.roles.includes("Admin")) return forbiddenResponse();
  await mutationRateLimit(req, caller, "deleteClub", "standard");

  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_CLUB_ID", "Missing club id");

  try {
    await readJson(
      getPrivateBlobClient(`clubs/${id}.json`),
      ClubSchema,
      `clubs/${id}.json`,
    );
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Club not found");
    }
    throw new HttpError(500, "INTERNAL");
  }

  await assertClubHasNoReferences(id);

  await removeClubFromIndex(id);
  await withPrivateLeaseRetry(`clubs/${id}.json`, async (leaseId) => {
    await getPrivateBlobClient(`clubs/${id}.json`).deleteIfExists({ conditions: { leaseId } });
  });

  return { status: 204 };
}

async function assertClubHasNoReferences(id: string): Promise<void> {
  try {
    const clubTeams = await readJson(getBlobClient("club-teams.json"), ClubTeamsIndexSchema, "club-teams.json").catch((err: unknown) => {
      if ((err as { statusCode?: number }).statusCode === 404) return [];
      throw err;
    });
    if (clubTeams.some((team) => team.clubId === id)) {
      throw new HttpError(409, "CLUB_IN_USE", "Club team references this club");
    }

    const sites = await readJson(getBlobClient("sites.json"), SitesIndexSchema, "sites.json").catch((err: unknown) => {
      if ((err as { statusCode?: number }).statusCode === 404) return [];
      throw err;
    });
    if (sites.some((site) => site.clubId === id)) {
      throw new HttpError(409, "CLUB_IN_USE", "Site references this club");
    }

    const seasons = await readJson(getBlobClient("seasons.json"), SeasonsIndexSchema, "seasons.json").catch((err: unknown) => {
      if ((err as { statusCode?: number }).statusCode === 404) return [];
      throw err;
    });
    for (const season of seasons) {
      if (await seasonClubReferencesClub(season, id)) {
        throw new HttpError(409, "CLUB_IN_USE", "Season-club registration references this club");
      }
    }
  } catch (err: unknown) {
    if (err instanceof HttpError && err.code === "CLUB_IN_USE") throw err;
    throw new HttpError(500, "CLUB_GUARD_UNVERIFIABLE", "Club references could not be fully verified");
  }
}

async function seasonClubReferencesClub(season: { year: number }, clubId: string): Promise<boolean> {
  const indexPath = `season-clubs/${season.year}/index.json`;
  const index = await readJson(getBlobClient(indexPath), SeasonClubIndexSchema, indexPath).catch((err: unknown) => {
    if ((err as { statusCode?: number }).statusCode === 404) return [];
    throw err;
  });
  if (index.some((entry) => entry.clubId === clubId)) return true;
  if (index.length > 0) return false;

  const prefix = `season-clubs/${season.year}/`;
  for await (const item of getPrivateContainer().listBlobsFlat({ prefix })) {
    if (!item.name.endsWith(".json") || item.name.endsWith("index.json")) continue;
    const seasonClub = await readJson(getPrivateBlobClient(item.name), SeasonClubSchema, item.name);
    if (seasonClub.clubId === clubId) return true;
  }
  return false;
}

// ─── Index helper ─────────────────────────────────────────────────────────────

async function upsertClubInIndex(summary: ClubSummary, insertIfMissing = true): Promise<void> {
  let index: ClubSummary[] = [];
  try {
    index = await readJson(
      getBlobClient("clubs.json"),
      ClubsIndexSchema,
      "clubs.json",
    );
  } catch (err: unknown) {
    if (!insertIfMissing && [409, 412].includes((err as { statusCode?: number }).statusCode ?? 0)) return;
    // index may not exist yet
  }

  const idx = index.findIndex((c) => c.id === summary.id);
  if (idx >= 0) {
    index[idx] = summary;
  } else if (!insertIfMissing) {
    return;
  } else {
    index.push(summary);
  }

  index.sort((a, b) => a.name.localeCompare(b.name));
  try {
    await writeJson("clubs.json", ClubsIndexSchema, index);
  } catch (err: unknown) {
    if (!insertIfMissing && [409, 412].includes((err as { statusCode?: number }).statusCode ?? 0)) return;
    throw err;
  }
}

async function removeClubFromIndex(id: string): Promise<void> {
  await ensureJsonIndexBlob("clubs.json", "[]");
  await withLeaseRetry("clubs.json", async (leaseId) => {
    let index: ClubSummary[] = [];
    try {
      index = await readJson(
        getBlobClient("clubs.json"),
        ClubsIndexSchema,
        "clubs.json",
      );
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode !== 404) throw err;
    }
    await writeJson("clubs.json", ClubsIndexSchema, index.filter((club) => club.id !== id), leaseId);
  });
}

// ─── Registration ─────────────────────────────────────────────────────────────

app.http("getClubs", { methods: ["GET"], authLevel: "anonymous", route: "clubs", handler: withErrorHandler(getClubs) });
app.http("createClub", { methods: ["POST"], authLevel: "anonymous", route: "clubs", handler: withErrorHandler(createClub) });
app.http("updateClub", { methods: ["PUT"], authLevel: "anonymous", route: "clubs/{id}", handler: withErrorHandler(updateClub) });
app.http("deleteClub", { methods: ["DELETE"], authLevel: "anonymous", route: "clubs/{id}", handler: withErrorHandler(deleteClub) });
