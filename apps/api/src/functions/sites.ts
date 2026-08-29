// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * Site endpoints
 *
 * GET    /api/sites       — site list (public; SiteSummary[] — no W3W)
 * GET    /api/sites/{id}  — full site detail (Admin OR RoundsCoord of site's club)
 * POST   /api/sites       — create site (Admin OR RoundsCoord; coord forced to own clubId)
 * PUT    /api/sites/{id}  — update site (Admin OR coord of site's club; coord cannot reassign clubId)
 * DELETE /api/sites/{id}  — delete site (Admin OR coord of site's club)
 */

import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { randomUUID } from "crypto";
import type {
  CallerIdentity,
  Site,
  SiteSummary,
  SiteStatus,
} from "@bccweb/types";
import { SiteSchema, SiteSummarySchema } from "@bccweb/schemas";
import * as z from "zod/v4";
import {
  getBlobClient,
  getPrivateBlobClient,
  getPrivateBlockBlobClient,
} from "../lib/blob.js";
import { readJson, writeJson, writePrivateJson } from "../lib/blobJson.js";
import {
  getCallerIdentity,
  unauthorizedResponse,
  forbiddenResponse,
} from "../lib/auth.js";
import { HttpError, withErrorHandler } from "../lib/http.js";
import { mutationRateLimit } from "../lib/rateLimit.js";

const SitesIndexSchema = z.array(SiteSummarySchema);

function isAdmin(caller: CallerIdentity): boolean {
  return caller.roles.includes("Admin");
}

function canCoordinateClub(caller: CallerIdentity, clubId: string): boolean {
  return caller.roles.includes("RoundsCoord") && caller.clubId === clubId;
}

// ─── GET /api/sites ───────────────────────────────────────────────────────────

async function getSites(
  _req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  try {
    const sites = await readJson(
      getBlobClient("sites.json"),
      SitesIndexSchema,
      "sites.json",
    );
    sites.sort((a, b) => a.name.localeCompare(b.name));
    return { status: 200, jsonBody: sites };
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return { status: 200, jsonBody: [] };
    }
    throw new HttpError(500, "INTERNAL");
  }
}

// ─── GET /api/sites/{id} ─────────────────────────────────────────────────────

async function getSiteById(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();

  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_SITE_ID", "Missing site id");

  let site: Site;
  try {
    site = await readJson(
      getPrivateBlobClient(`sites/${id}.json`),
      SiteSchema,
      `sites/${id}.json`,
    );
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Site not found");
    }
    throw new HttpError(500, "INTERNAL");
  }

  if (!isAdmin(caller) && !canCoordinateClub(caller, site.clubId)) {
    return forbiddenResponse();
  }

  return { status: 200, jsonBody: site };
}

// ─── POST /api/sites ──────────────────────────────────────────────────────────

interface CreateSiteBody {
  name: string;
  clubId: string;
  status?: SiteStatus;
  parkingW3W?: string;
  briefingW3W?: string;
  takeOffW3W?: string;
  guideUrl?: string;
  contactInfo?: string;
}

async function createSite(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isAdmin(caller) && !caller.roles.includes("RoundsCoord")) {
    return forbiddenResponse();
  }

  let body: CreateSiteBody;
  try {
    body = (await req.json()) as CreateSiteBody;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON");
  }

  if (!body.name?.trim()) {
    throw new HttpError(400, "INVALID_BODY", "name is required");
  }
  if (!body.clubId) {
    throw new HttpError(400, "INVALID_BODY", "clubId is required");
  }

  if (!isAdmin(caller) && !canCoordinateClub(caller, body.clubId)) {
    return forbiddenResponse();
  }

  await mutationRateLimit(req, caller, "createSite", "standard");

  const id = randomUUID();
  const site: Site = {
    id,
    name: body.name.trim(),
    status: body.status ?? "Active",
    clubId: body.clubId,
    parkingW3W: body.parkingW3W,
    briefingW3W: body.briefingW3W,
    takeOffW3W: body.takeOffW3W,
    guideUrl: body.guideUrl,
    contactInfo: body.contactInfo,
  };

  await writePrivateJson(`sites/${id}.json`, SiteSchema, site);
  await upsertSiteInIndex({
    id,
    name: site.name,
    status: site.status,
    clubId: site.clubId,
  });

  return { status: 201, jsonBody: site };
}

// ─── PUT /api/sites/{id} ──────────────────────────────────────────────────────

async function updateSite(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();

  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_SITE_ID", "Missing site id");

  let existing: Site;
  try {
    existing = await readJson(
      getPrivateBlobClient(`sites/${id}.json`),
      SiteSchema,
      `sites/${id}.json`,
    );
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(404, "NOT_FOUND", "Site not found");
    }
    throw new HttpError(500, "INTERNAL");
  }

  if (!isAdmin(caller) && !canCoordinateClub(caller, existing.clubId)) {
    return forbiddenResponse();
  }

  await mutationRateLimit(req, caller, "updateSite", "standard");

  let body: Partial<Site>;
  try {
    body = (await req.json()) as Partial<Site>;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON");
  }

  // Coords cannot reassign a site to a different club.
  if (!isAdmin(caller) && body.clubId && body.clubId !== existing.clubId) {
    throw new HttpError(
      403,
      "CLUB_CHANGE_FORBIDDEN",
      "Only Admin can change a site's club"
    );
  }

  const updated: Site = {
    ...existing,
    name: body.name?.trim() ?? existing.name,
    status: body.status ?? existing.status,
    clubId: isAdmin(caller) ? (body.clubId ?? existing.clubId) : existing.clubId,
    parkingW3W: body.parkingW3W ?? existing.parkingW3W,
    briefingW3W: body.briefingW3W ?? existing.briefingW3W,
    takeOffW3W: body.takeOffW3W ?? existing.takeOffW3W,
    guideUrl: body.guideUrl ?? existing.guideUrl,
    contactInfo: body.contactInfo ?? existing.contactInfo,
    id: existing.id,
  };

  await writePrivateJson(`sites/${id}.json`, SiteSchema, updated);
  await upsertSiteInIndex({
    id,
    name: updated.name,
    status: updated.status,
    clubId: updated.clubId,
  });

  return { status: 200, jsonBody: updated };
}

// ─── DELETE /api/sites/{id} ──────────────────────────────────────────────────

async function deleteSite(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();

  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_SITE_ID", "Missing site id");

  let existing: Site;
  try {
    existing = await readJson(
      getPrivateBlobClient(`sites/${id}.json`),
      SiteSchema,
      `sites/${id}.json`,
    );
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      return { status: 204 };
    }
    throw new HttpError(500, "INTERNAL");
  }

  if (!isAdmin(caller) && !canCoordinateClub(caller, existing.clubId)) {
    return forbiddenResponse();
  }

  await mutationRateLimit(req, caller, "deleteSite", "standard");

  await getPrivateBlockBlobClient(`sites/${id}.json`).deleteIfExists();
  await removeSiteFromIndex(id);

  return { status: 204 };
}

// ─── Index helpers ────────────────────────────────────────────────────────────

async function upsertSiteInIndex(summary: SiteSummary): Promise<void> {
  let index: SiteSummary[] = [];
  try {
    index = await readJson(
      getBlobClient("sites.json"),
      SitesIndexSchema,
      "sites.json",
    );
  } catch {
    // index may not exist yet
  }

  const idx = index.findIndex((s) => s.id === summary.id);
  if (idx >= 0) {
    index[idx] = summary;
  } else {
    index.push(summary);
  }

  index.sort((a, b) => a.name.localeCompare(b.name));
  await writeJson("sites.json", SitesIndexSchema, index);
}

async function removeSiteFromIndex(id: string): Promise<void> {
  let index: SiteSummary[] = [];
  try {
    index = await readJson(
      getBlobClient("sites.json"),
      SitesIndexSchema,
      "sites.json",
    );
  } catch {
    return;
  }
  const filtered = index.filter((s) => s.id !== id);
  if (filtered.length === index.length) return;
  await writeJson("sites.json", SitesIndexSchema, filtered);
}

// ─── Registration ─────────────────────────────────────────────────────────────

app.http("getSites", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "sites",
  handler: withErrorHandler(getSites),
});

app.http("getSiteById", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "sites/{id}",
  handler: withErrorHandler(getSiteById),
});

app.http("createSite", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "sites",
  handler: withErrorHandler(createSite),
});

app.http("updateSite", {
  methods: ["PUT"],
  authLevel: "anonymous",
  route: "sites/{id}",
  handler: withErrorHandler(updateSite),
});

app.http("deleteSite", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "sites/{id}",
  handler: withErrorHandler(deleteSite),
});
