#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * migrate.mjs
 *
 * One-time migration: Azure SQL (BCCWeb) → Azure Blob Storage JSON.
 *
 * Usage:
 *   SQL_CONNECTION_STRING="Server=...;Database=...;User Id=...;Password=...;Encrypt=true;" \
 *   BLOB_CONNECTION_STRING="DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net" \
 *   node scripts/migrate/migrate.mjs [--dry-run] [--resume] [--force-production]
 *
 * Or use the invoking operator/OIDC identity:
 *   SQL_CONNECTION_STRING="..." BLOB_STORAGE_ACCOUNT_NAME="stbccwebstagingdata" \
 *   node scripts/migrate/migrate.mjs [--dry-run] [--resume] [--force-production]
 *
 * For local dev against Azurite:
 *   SQL_CONNECTION_STRING="..." \
 *   BLOB_CONNECTION_STRING="UseDevelopmentStorage=true" \
 *   DRY_RUN=1 node scripts/migrate/migrate.mjs
 *
 * Flags:
 *   --dry-run          No blobs written; id-map.json still persisted (also: DRY_RUN=1 env)
 *   --resume           Skip blobs whose SHA-256 content hash is unchanged vs stored blob
 *   --force-production Required (along with PRODUCTION_CONFIRM=YES env) to write to bcc-prod
 *
 * Migration order (respects FK dependencies):
 *   1. config.json
 *   2. manufacturers.json
 *   3. pilot-ratings.json
 *   4. clubs.json + clubs/{uuid}.json
 *   5. frequencies.json + season-clubs/{year}/{clubId}.json
 *   6. sites.json + sites/{uuid}.json
 *   7. seasons.json (partial) + seasons/{year}.json (partial)
 *   8. pilots.json + pilots/{uuid}.json
 *   9. rounds.json + rounds/{uuid}.json (with teams/pilots/flights embedded)
 *  10. round-briefs/{uuid}.json
 *  11. Recompute seasons/{year}.json (league) + results/{year}.json
 */

// Deps-current note (T14): mssql@12.6.0 and @azure/storage-blob@12.33.0 are
// already at current versions (bumped historically in #84/#86). PR #112, which
// updates root-workspace apps/api storage-blob/puppeteer-core and apps/web
// react-router, does NOT touch this standalone scripts/migrate package.

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import sql from "mssql";
// computeLeague is IMPORTED from @bccweb/scoring (not copied). Even though
// scripts/migrate is a standalone package (own lockfile) it is run from the repo
// checkout, so @bccweb/scoring resolves via the workspace root node_modules
// (its `main` → packages/scoring/dist) — the same mechanism validate.mjs uses for
// @bccweb/schemas (run `make build` first). Using the real engine keeps the
// migrated league snapshot in lockstep with what the API re-derives post-cutover.
import { computeLeague } from "@bccweb/scoring";
import { getOrCreateUuid, saveIdMap } from "./id-map.mjs";
import { buildPilotClubHistory, queryPilotClubRows } from "./pilot-club-history-logic.mjs";
import { writeDiscardedCounts } from "./discarded-counts.mjs";
import { writeNormalizationCounts } from "./normalization-counts.mjs";
import { createTally, normalizeCoachType, normalizePilotRating, normalizeRoundStatus, normalizeScoringType, normalizeWingClass } from "./enum-normalize.mjs";
import { assertSeasonYear, briefImageBlobFromLegacy, briefImagePath, ensureNonEmpty, normalizeWebsiteUrl, parseFrequencyMhz, manufacturerFromLegacyRow, legacySignaturePath, legacyMigratedSignature, pilotSummaryFromMigration } from "./transforms.mjs";
import { legacyScoreManifestPath, writeLegacyScoreManifest } from "./legacy-score-manifest.mjs";
import { createBlobServiceClient } from "./blobClient.mjs";
import { summarizeSqlConnectionString } from "./connectionSummary.mjs";

// ─── CLI flags ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run") || process.env.DRY_RUN === "1";
const RESUME = argv.includes("--resume");
const FORCE_PRODUCTION = argv.includes("--force-production");

// ─── Config ───────────────────────────────────────────────────────────────────

const SQL_CS = process.env.SQL_CONNECTION_STRING;
const CONTAINER = process.env.BLOB_CONTAINER ?? "data";
const PRIVATE_CONTAINER = process.env.BLOB_PRIVATE_CONTAINER ?? "data-private";

// ─── Blob helpers ─────────────────────────────────────────────────────────────

let containerClient;
let privateContainerClient;

function initBlobClients() {
  if (containerClient && privateContainerClient) return;
  const blobService = createBlobServiceClient();
  containerClient = blobService.getContainerClient(CONTAINER);
  privateContainerClient = blobService.getContainerClient(PRIVATE_CONTAINER);
}

async function uploadBlob(path, obj) {
  initBlobClients();
  const json = JSON.stringify(obj, null, 2);
  if (DRY_RUN) {
    console.log(`  [DRY] would write ${path} (${json.length} bytes) → public`);
    return;
  }
  const client = containerClient.getBlockBlobClient(path);
  if (RESUME) {
    try {
      const buf = await client.downloadToBuffer();
      const existingHash = createHash("sha256").update(buf).digest("hex");
      const newHash = createHash("sha256").update(json, "utf8").digest("hex");
      if (existingHash === newHash) {
        console.log(`  [RESUME] skip ${path} (unchanged)`);
        return;
      }
    } catch {
      // blob does not exist yet — proceed with upload
    }
  }
  await client.upload(json, Buffer.byteLength(json), {
    blobHTTPHeaders: { blobContentType: "application/json" },
  });
}

async function uploadPrivateBlob(path, obj) {
  initBlobClients();
  const json = JSON.stringify(obj, null, 2);
  if (DRY_RUN) {
    console.log(`  [DRY] would write ${path} (${json.length} bytes) → private`);
    return;
  }
  const client = privateContainerClient.getBlockBlobClient(path);
  if (RESUME) {
    try {
      const buf = await client.downloadToBuffer();
      const existingHash = createHash("sha256").update(buf).digest("hex");
      const newHash = createHash("sha256").update(json, "utf8").digest("hex");
      if (existingHash === newHash) {
        console.log(`  [RESUME] skip ${path} (unchanged)`);
        return;
      }
    } catch {
      // blob does not exist yet — proceed with upload
    }
  }
  await client.upload(json, Buffer.byteLength(json), {
    blobHTTPHeaders: { blobContentType: "application/json" },
  });
}

async function uploadPrivateBinaryBlob(path, bytes, contentType) {
  initBlobClients();
  if (DRY_RUN) {
    console.log(`  [DRY] would write ${path} (${bytes.length} bytes) → private`);
    return;
  }
  const client = privateContainerClient.getBlockBlobClient(path);
  if (RESUME) {
    try {
      const buf = await client.downloadToBuffer();
      const existingHash = createHash("sha256").update(buf).digest("hex");
      const newHash = createHash("sha256").update(bytes).digest("hex");
      if (existingHash === newHash) {
        console.log(`  [RESUME] skip ${path} (unchanged)`);
        return;
      }
    } catch {
    }
  }
  await client.uploadData(bytes, {
    blobHTTPHeaders: { blobContentType: contentType },
  });
}

// ─── Enum mappings ────────────────────────────────────────────────────────────

const COACH_TYPE_MAP = {
  0: "None",
  1: "ClubCoach",
  2: "SeniorCoach",
  3: "Instructor",
  4: "SeniorInstructor",
};

// Status descriptions from the SQL Statuses table:
// 1:Proposed, 2:Confirmed, 3:Cancelled, 4:Submitted, 5:Verified,
// 6:Active, 7:Inactive, 8:Locked, 9:Complete, 10:Deleted, 11:Brief Complete
// Round statuses used in new app: Proposed | Confirmed | BriefComplete | Locked | Complete | Cancelled
function mapStatus(description, tally) {
  return normalizeRoundStatus(description, tally) ?? "Proposed";
}

function mapSiteStatus(description) {
  if (!description) return "Active";
  return description.trim() === "Active" ? "Active" : "Inactive";
}

function pick(row, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row, name) && row[name] != null) return row[name];
  }
  return null;
}

async function safeQuery(pool, query) {
  try {
    return (await pool.request().query(query)).recordset;
  } catch (err) {
    if (err?.number === 208 || /Invalid object name/i.test(err?.message ?? "")) return [];
    throw err;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!SQL_CS) throw new Error("Missing SQL_CONNECTION_STRING env var");
  initBlobClients();

  if (/Server=tcp:.*bcc-prod/i.test(SQL_CS)) {
    if (!(FORCE_PRODUCTION && process.env.PRODUCTION_CONFIRM === "YES")) {
      console.error("refusing to run against production without --force-production");
      process.exit(1);
    }
    console.warn("*** PRODUCTION RUN CONFIRMED — writing to bcc-prod ***");
  }

  console.log("BCCWeb SQL → Blob Migration");
  console.log(`  SQL: ${JSON.stringify(summarizeSqlConnectionString(SQL_CS))}`);
  console.log(`  Blob container (public):  ${CONTAINER}`);
  console.log(`  Blob container (private): ${PRIVATE_CONTAINER}`);
  if (DRY_RUN) console.log("  DRY RUN — no blobs will be written");
  if (RESUME) console.log("  RESUME mode — unchanged blobs will be skipped");
  console.log("");

  // Connect to SQL
  const pool = await sql.connect(SQL_CS);
  console.log("Connected to SQL Server\n");

  // Preflight data-shape checks that must fail before any blob write occurs.
  const seasonYearRows = await pool.request().query("SELECT ID, Year FROM Seasons");
  for (const r of seasonYearRows.recordset) {
    assertSeasonYear(r.Year);
  }
  console.log(`Preflight: validated ${seasonYearRows.recordset.length} season years\n`);

  // ID → UUID maps (populated as we migrate each entity; used for cross-references)
  const clubUuid = new Map();      // SQL int ID → uuid
  const siteUuid = new Map();      // SQL int ID → uuid
  const seasonUuid = new Map();    // SQL int ID → uuid
  const pilotUuid = new Map();     // SQL int ID → uuid
  const roundUuid = new Map();     // SQL int ID → uuid
  const teamUuid = new Map();      // SQL int ID → uuid (RoundTeams table)
  const mfrUuid = new Map();       // SQL int ID → uuid
  const mfrNameBySqlId = new Map(); // SQL int ID → manufacturer name
  const ratingUuid = new Map();    // SQL int ID → uuid
  const freqMhzByYearClub = new Map(); // `${seasonYear}:${clubUuid}` → number (MHz)
  const tally = createTally();
  let nonEmptyPersonNameFixes = 0;
  let sentinelSiteRounds = 0;
  let fallbackClubTeams = 0;
  let legacySignaturesStamped = 0;
  let briefsFrequencyMhz = 0;

  // ── 1. config.json ──────────────────────────────────────────────────────────
  console.log("Step 1: config.json");
  // Config is stored in web.config AppSettings in the original app.
  // We write the LEGACY-CORRECT normalized-scoring defaults (verbatim from the
  // .NET source — Web.config:97-109 + BaseController.cs); the admin can update
  // via the admin UI post-migration. The full factor tables + counts +
  // taskMaxPoints MUST be present so validate.mjs can assert the new scoring
  // config keys are populated and so ConfigSchema reads it without healing.
  //   - maxPilotsInTeam = 9 (Web.config:99; the prior 12 was drift — restored)
  //   - taskMaxPoints = 1000 (BaseController.cs:2461)
  //   - pilotFactors (BaseController.cs:1661-1678 GetPilotFactor)
  //   - clubsAttendingFactors (BaseController.cs:2254-2275 GetClubsAttendingFactor)
  //   - minDistanceFactors (BaseController.cs:2277-2309 GetMinDistanceFactor)
  const config = {
    maxTeamsInClub: 2,
    maxPilotsInTeam: 9,
    maxScoringPilotsInTeam: 6,
    maxPilotScoresCountedPerTeam: 4,
    leagueRoundScoresCounted: 6,
    taskMaxPoints: 1000,
    flightDateValidationEnabled: true,
    wingFactors: {
      "EN A": 1.0,
      "EN B": 0.9,
      "EN C": 0.8,
      "EN C 2-liner": 0.7,
      "EN D": 0.6,
      "EN D 2-liner": 0.5,
    },
    pilotFactors: {
      "Club Pilot": 1,
      Pilot: 1,
      "Advanced Pilot": 0.9,
    },
    clubsAttendingFactors: {
      fewerThanThreeClubs: 0.5,
      exactlyThreeClubs: 0.75,
      moreThanThreeClubs: 1,
    },
    minDistanceFactors: {
      oneFlight: 0.2,
      twoFlights: 0.4,
      threeFlights: 0.6,
      fourFlights: 0.8,
      fiveOrMoreFlights: 1,
    },
  };
  await uploadPrivateBlob("config.json", config);
  console.log("  wrote config.json → private\n");

  // ── 2. Manufacturers ────────────────────────────────────────────────────────
  console.log("Step 2: manufacturers.json");
  const mfrs = await pool.request().query("SELECT ID, Name, WebsiteUrl FROM Manufacturers ORDER BY Name");
  const manufacturersList = mfrs.recordset.map((r) => {
    const mfr = manufacturerFromLegacyRow(r);
    mfrUuid.set(r.ID, mfr.id);
    mfrNameBySqlId.set(r.ID, r.Name);
    return mfr;
  });
  await uploadBlob("manufacturers.json", manufacturersList);
  saveIdMap();
  console.log(`  wrote ${manufacturersList.length} manufacturers\n`);

  // ── 3. Pilot ratings ────────────────────────────────────────────────────────
  console.log("Step 3: pilot ratings (lookup table — no blob written)");
  const ratings = await pool.request().query("SELECT ID, Description FROM PilotRatings ORDER BY ID");
  const ratingsList = ratings.recordset.map((r) => {
    const id = getOrCreateUuid("rating", r.ID);
    ratingUuid.set(r.ID, id);
    return { id, legacyId: r.ID, description: r.Description };
  });
  saveIdMap();
  console.log(`  resolved ${ratingsList.length} pilot ratings for lookup\n`);

  // ── 4. Clubs ────────────────────────────────────────────────────────────────
  console.log("Step 4: clubs.json + clubs/{uuid}.json");
  const clubs = await pool.request().query("SELECT ID, Name FROM Clubs ORDER BY Name");
  const clubsList = [];
  for (const r of clubs.recordset) {
    const id = getOrCreateUuid("club", r.ID);
    clubUuid.set(r.ID, id);
    clubsList.push({ id, legacyId: r.ID, name: r.Name, sites: [], teams: [] });
  }
  await uploadBlob("clubs.json", clubsList.map(({ id, name }) => ({ id, name })));
  for (const c of clubsList) {
    await uploadPrivateBlob(`clubs/${c.id}.json`, c);
  }
  saveIdMap();
  console.log(`  wrote ${clubsList.length} clubs\n`);

  console.log("Step 5: season-clubs/{year}/{clubId}.json");
  const frequencyRows = await safeQuery(pool, "SELECT * FROM Frequencies ORDER BY ID");

  let seasonClubFrequencyRows = await safeQuery(pool, "SELECT * FROM SeasonClubFrequencies");
  if (seasonClubFrequencyRows.length === 0) {
    seasonClubFrequencyRows = await safeQuery(pool, "SELECT * FROM SeasonClubFrequency");
  }
  const frequencyLegacyIdBySeasonClubLegacyId = new Map();
  for (const r of seasonClubFrequencyRows) {
    const seasonClubLegacyId = pick(r, ["SeasonClub_ID", "SeasonClubID", "seasonClub_ID", "seasonClubID", "ID"]);
    const frequencyLegacyId = pick(r, ["Frequency_ID", "FrequencyID", "frequency_ID", "frequencyID"]);
    if (seasonClubLegacyId != null && frequencyLegacyId != null) {
      frequencyLegacyIdBySeasonClubLegacyId.set(seasonClubLegacyId, frequencyLegacyId);
    }
  }

  const seasonClubRows = await safeQuery(pool, "SELECT * FROM SeasonClubs ORDER BY ID");
  const seasonRowsForSeasonClubs = await safeQuery(pool, "SELECT ID, Year FROM Seasons");
  const seasonYearByLegacyId = new Map(seasonRowsForSeasonClubs.map((s) => [s.ID, s.Year]));
  const seasonClubIndexByYear = new Map();
  for (const r of seasonClubRows) {
    const legacyId = pick(r, ["ID", "Id", "SeasonClubID"]);
    const seasonLegacyId = pick(r, ["Season_ID", "SeasonID", "season_ID", "seasonID"]);
    const clubLegacyId = pick(r, ["Club_ID", "ClubID", "club_ID", "clubID"]);
    const seasonYear = seasonYearByLegacyId.get(seasonLegacyId);
    const clubId = clubLegacyId != null ? clubUuid.get(clubLegacyId) : null;
    const club = clubId ? clubsList.find((c) => c.id === clubId) : null;
    if (!seasonYear || !club) continue;
    const frequencyLegacyId = legacyId != null ? frequencyLegacyIdBySeasonClubLegacyId.get(legacyId) : null;
    const frequency = frequencyLegacyId != null ? frequencyRows.find((f) => pick(f, ["ID", "Id", "FrequencyID", "Frequency_ID"]) === frequencyLegacyId) : undefined;
    const frequencyMhz = parseFrequencyMhz(frequency ? pick(frequency, ["Freq", "Label", "Name", "Description", "Frequency", "Title"]) : null);
    if (frequencyMhz !== undefined) freqMhzByYearClub.set(`${seasonYear}:${club.id}`, frequencyMhz);
    const acceptedAtRaw = pick(r, ["AcceptedTsCsAt", "AcceptedTcsAt", "TermsAcceptedAt"]);
    const acceptedTsCsAt = acceptedAtRaw ? new Date(acceptedAtRaw).toISOString() : undefined;
    const acceptedTsCs = Boolean(pick(r, ["AcceptTsCs", "AcceptedTsCs", "acceptTsCs"]));
    const numTeams = Number(pick(r, ["NumTeams", "numTeams", "NumberOfTeams", "NoTeams"]) ?? 1);
    const id = getOrCreateUuid("season-club", `${seasonYear}-${club.id}`);
    const seasonClub = {
      id,
      ...(legacyId != null ? { legacyId } : {}),
      seasonYear,
      clubId: club.id,
      numTeams,
      acceptedTsCs,
      ...(acceptedTsCsAt ? { acceptedTsCsAt } : {}),
    };
    await uploadPrivateBlob(`season-clubs/${seasonYear}/${club.id}.json`, seasonClub);
    if (!seasonClubIndexByYear.has(seasonYear)) seasonClubIndexByYear.set(seasonYear, []);
    seasonClubIndexByYear.get(seasonYear).push({
      id,
      seasonYear,
      clubId: club.id,
      clubName: club.name,
      numTeams,
      acceptedTsCs,
      ...(acceptedTsCsAt ? { acceptedTsCsAt } : {}),
    });
  }
  for (const [year, index] of seasonClubIndexByYear.entries()) {
    index.sort((a, b) => a.clubName.localeCompare(b.clubName));
    await uploadBlob(`season-clubs/${year}/index.json`, index);
  }
  saveIdMap();
  console.log(`  wrote ${seasonClubRows.length} season club rows\n`);

  // ── 5. Sites ────────────────────────────────────────────────────────────────
  console.log("Step 6: sites.json + sites/{uuid}.json");
  const sites = await pool
    .request()
    .query(`
      SELECT s.ID, s.Name, s.Club_ID, s.SiteGuideURL, s.ParkingW3W, s.BriefingW3W, s.TakeOffW3W,
             st.Description AS StatusDesc
      FROM Sites s
      LEFT JOIN Statuses st ON st.ID = s.StatusID
      ORDER BY s.Name
    `);
  const sitesList = [];
  for (const r of sites.recordset) {
    const id = getOrCreateUuid("site", r.ID);
    siteUuid.set(r.ID, id);
    const clubId = r.Club_ID ? clubUuid.get(r.Club_ID) : null;
    const site = {
      id,
      legacyId: r.ID,
      name: r.Name,
      status: mapSiteStatus(r.StatusDesc),
      clubId: clubId ?? null,
      ...(r.ParkingW3W ? { parkingW3W: r.ParkingW3W } : {}),
      ...(r.BriefingW3W ? { briefingW3W: r.BriefingW3W } : {}),
      ...(r.TakeOffW3W ? { takeOffW3W: r.TakeOffW3W } : {}),
      ...(r.SiteGuideURL ? { guideUrl: r.SiteGuideURL } : {}),
    };
    sitesList.push(site);
    // Also link site → club document
    if (clubId) {
      const club = clubsList.find((c) => c.id === clubId);
      if (club && !club.sites.includes(id)) club.sites.push(id);
    }
  }
  await uploadBlob("sites.json", sitesList.map(({ id, name, status, clubId }) => ({ id, name, status, clubId })));
  for (const s of sitesList) {
    await uploadPrivateBlob(`sites/${s.id}.json`, s);
  }
  // Re-write club docs with updated sites arrays
  for (const c of clubsList) {
    await uploadPrivateBlob(`clubs/${c.id}.json`, c);
  }
  saveIdMap();
  console.log(`  wrote ${sitesList.length} sites\n`);

  // ── 7. Seasons (partial) ────────────────────────────────────────────────────
  console.log("Step 7: seasons.json");
  const seasons = await pool
    .request()
    .query("SELECT ID, Year, active FROM Seasons ORDER BY Year");
  const seasonsList = [];
  for (const r of seasons.recordset) {
    const id = getOrCreateUuid("season", r.ID);
    seasonUuid.set(r.ID, id);
    seasonsList.push({
      id,
      legacyId: r.ID,
      year: r.Year,
      active: !!r.active,
      rounds: [],
      leagueTable: [],
    });
  }
  await uploadBlob("seasons.json", seasonsList.map(({ id, year, active }) => ({ id, year, active })));
  saveIdMap();
  console.log(`  wrote ${seasonsList.length} seasons\n`);

  // ── 8. Pilots ───────────────────────────────────────────────────────────────
  console.log("Step 8: pilots.json + pilots/{uuid}.json");
  const pilotsResult = await pool.request().query(`
    SELECT
      p.ID, p.BHPA_Number, p.CoachType, p.UserID,
      p.PureTrackLink, p.PureTrackID,
      p.HelmetColour, p.HarnessType, p.HarnessColour,
      p.EmergencyContactName, p.EmergencyPhoneNumber, p.MedicalInfo,
      p.WingModel, p.WingClass, p.WingColours,
      p.Pilot_Rating_ID,
      p.Manufacturer_ID AS MfrID,
      p.PersonID,
      per.FirstName, per.LastName, per.FullName, per.PhoneNumber,
      mfr.Name AS MfrName,
      mfr.WebsiteUrl AS MfrWebsiteUrl,
      u.Email AS UserEmail
    FROM Pilots p
    LEFT JOIN People per ON per.ID = p.PersonID
    LEFT JOIN Manufacturers mfr ON mfr.ID = p.Manufacturer_ID
    LEFT JOIN AspNetUsers u ON u.Id = p.UserID
    ORDER BY per.LastName, per.FirstName
  `);

  // PilotSeasonClubs
  const pscResult = await pool.request().query(`
    SELECT psc.pilot_ID, psc.season_ID, psc.club_ID, c.Name AS ClubName, s.Year AS SeasonYear
    FROM PilotSeasonClubs psc
    LEFT JOIN Clubs c ON c.ID = psc.club_ID
    LEFT JOIN Seasons s ON s.ID = psc.season_ID
  `);
  /** @type {Map<number, Array<{seasonYear:number, clubId:string, clubName:string}>>} */
  const pscBySqlPilotId = new Map();
  for (const r of pscResult.recordset) {
    if (!pscBySqlPilotId.has(r.pilot_ID)) pscBySqlPilotId.set(r.pilot_ID, []);
    const clubId = r.club_ID ? clubUuid.get(r.club_ID) : null;
    if (clubId) {
      pscBySqlPilotId.get(r.pilot_ID).push({
        seasonYear: r.SeasonYear,
        clubId,
        clubName: r.ClubName ?? "",
      });
    }
  }

  const pilotEmailIndex = {};
  const pilotsSummary = [];
  for (const r of pilotsResult.recordset) {
    const id = getOrCreateUuid("pilot", r.ID);
    pilotUuid.set(r.ID, id);

    const seasonClubs = pscBySqlPilotId.get(r.ID) ?? [];
    // Current club = most recent season club
    const currentSeasonClub = [...seasonClubs].sort((a, b) => b.seasonYear - a.seasonYear)[0];

    const fullName =
      r.FullName?.trim() ||
      [r.FirstName, r.LastName].filter(Boolean).join(" ") ||
      "Unknown";
    const firstName = ensureNonEmpty(r.FirstName, fullName || "Unknown");
    const lastName = ensureNonEmpty(r.LastName, fullName || "Unknown");
    if ((r.FirstName == null || String(r.FirstName).trim().length === 0) ||
        (r.LastName == null || String(r.LastName).trim().length === 0)) {
      nonEmptyPersonNameFixes++;
    }

    const ratingEntry = ratingsList.find((x) => x.legacyId === r.Pilot_Rating_ID);
    const pilotRating = normalizePilotRating(ratingEntry?.description, tally) ?? "Pilot";
    const wingClass = normalizeWingClass(r.WingClass, tally);

    const coachType = COACH_TYPE_MAP[r.CoachType] ?? "None";

    const mfrId = r.MfrID ? mfrUuid.get(r.MfrID) : null;
    const wingManufacturer = mfrId
      ? {
          id: mfrId,
          name: r.MfrName,
          ...(normalizeWebsiteUrl(r.MfrWebsiteUrl) ? { websiteUrl: normalizeWebsiteUrl(r.MfrWebsiteUrl) } : {}),
        }
      : undefined;

    const pilotDoc = {
      id,
      legacyId: r.ID,
      ...(r.BHPA_Number != null ? { bhpaNumber: r.BHPA_Number } : {}),
      coachType,
      pilotRating,
      ...(r.PureTrackID != null ? { pureTrackId: r.PureTrackID } : {}),
      ...(r.PureTrackLink ? { pureTrackLink: r.PureTrackLink } : {}),
      ...(r.HelmetColour ? { helmetColour: r.HelmetColour } : {}),
      ...(r.HarnessType ? { harnessType: r.HarnessType } : {}),
      ...(r.HarnessColour ? { harnessColour: r.HarnessColour } : {}),
      ...(r.EmergencyContactName ? { emergencyContactName: r.EmergencyContactName } : {}),
      ...(r.EmergencyPhoneNumber ? { emergencyPhoneNumber: r.EmergencyPhoneNumber } : {}),
      ...(r.MedicalInfo ? { medicalInfo: r.MedicalInfo } : {}),
      ...(r.WingClass && wingClass ? { wingClass } : {}),
      ...(wingManufacturer ? { wingManufacturer } : {}),
      ...(r.WingModel ? { wingModel: r.WingModel } : {}),
      ...(r.WingColours ? { wingColours: r.WingColours } : {}),
      person: {
        // PersonID is the stable FK to the People table; fall back to pilot SQL ID
        // in the unlikely event PersonID is null (orphaned pilot record).
        id: getOrCreateUuid("person", r.PersonID ?? r.ID),
        firstName,
        lastName,
        fullName,
        ...(r.PhoneNumber ? { phoneNumber: r.PhoneNumber } : {}),
      },
      ...(currentSeasonClub
        ? { currentClub: { id: currentSeasonClub.clubId, name: currentSeasonClub.clubName } }
        : {}),
      seasonClubs,
      userId: null, // no user accounts migrated — pilots self-register post-migration
    };

    await uploadPrivateBlob(`pilots/${id}.json`, pilotDoc);

    pilotsSummary.push(pilotSummaryFromMigration({
      id,
      legacyId: r.ID,
      name: fullName,
      currentSeasonClub,
      rating: pilotRating,
    }));

    if (r.UserEmail) {
      pilotEmailIndex[r.UserEmail.toLowerCase()] = id;
    }
  }
  await uploadBlob("pilots.json", pilotsSummary);
  await uploadPrivateBlob("pilot-email-index.json", pilotEmailIndex);
  saveIdMap();
  console.log(`  wrote ${pilotsSummary.length} pilots\n`);

  // ── 7b. Pilot club history ───────────────────────────────────────────────────
  console.log("Step 7b: pilots/{uuid}/club-history.json");
  const pilotClubRows = await queryPilotClubRows(pool);

  const pilotsWithCurrentClub = pilotsResult.recordset
    .map((r) => {
      const pilotId = pilotUuid.get(r.ID);
      if (!pilotId) return null;
      const seasonClubs = pscBySqlPilotId.get(r.ID) ?? [];
      const currentSeasonClub = [...seasonClubs].sort((a, b) => b.seasonYear - a.seasonYear)[0];
      return { pilotId, currentSeasonClub };
    })
    .filter(Boolean);

  const historyByPilot = buildPilotClubHistory(
    pilotClubRows,
    pilotUuid,
    clubUuid,
    clubsList,
    pilotsWithCurrentClub,
  );

  let historyBlobCount = 0;
  for (const [pilotId, memberships] of historyByPilot) {
    await uploadPrivateBlob(`pilots/${pilotId}/club-history.json`, memberships);
    historyBlobCount++;
  }
  saveIdMap();
  console.log(`  wrote ${historyBlobCount} pilot club-history blobs (${pilotClubRows.length} legacy rows)\n`);

  // ── 9. Rounds (with teams, pilot slots, flights) ────────────────────────────
  console.log("Step 9: rounds.json + rounds/{uuid}.json");

  // Fetch all rounds
  const roundsResult = await pool.request().query(`
    SELECT
      r.ID, r.Date, r.isLocked, r.MaxTeams, r.MinimumScore,
      r.BriefingTime, r.LandByTime, r.CheckInByTime,
      r.Narrative, r.PureTrackGroupName, r.PureTrackGroupSlug, r.PureTrackGroup_ID,
      r.OrganisingClub_ID, r.Season_ID,
      s.ID AS SiteID, s.Name AS SiteName, s.ParkingW3W, s.BriefingW3W, s.TakeOffW3W,
      st.Description AS StatusDesc,
      sea.Year AS SeasonYear
    FROM Rounds r
    LEFT JOIN Sites s ON s.ID = r.SiteID
    LEFT JOIN Statuses st ON st.ID = r.StatusID
    LEFT JOIN Seasons sea ON sea.ID = r.Season_ID
    ORDER BY r.Date
  `);

  // Fetch all round teams
  const rtResult = await pool.request().query(`
    SELECT rt.ID, rt.RoundID, rt.TeamID, rt.TeamScore,
           rt.PureTrackGroupName, rt.PureTrackGroupSlug, rt.PureTrackGroup_ID,
           t.TeamName, t.ClubID
    FROM RoundTeams rt
    LEFT JOIN Teams t ON t.ID = rt.TeamID
  `);

  // Fetch all round team places (pilot slots)
  const rtpResult = await pool.request().query(`
    SELECT rp.ID, rp.PlaceInTeam, rp.IsScoring, rp.Status, rp.RoundTeam_ID,
           rp.RoundTeamPilot_ID,
           rtp.Pilot_ID, rtp.noScore, rtp.PilotPoints, rtp.PhoneNumber,
           rtp.WingClass, rtp.WingColours, rtp.WingModel,
           rtp.HelmetColour, rtp.HarnessType, rtp.HarnessColour,
           rtp.EmergencyContactName, rtp.EmergencyPhoneNumber, rtp.MedicalInfo,
           rtp.AccountedFor, rtp.SignToFly,
           rtp.Manufacturer_ID,
           pr.Description AS PilotRatingDesc
    FROM RoundTeamPlaces rp
    LEFT JOIN RoundTeamPilots rtp ON rtp.ID = rp.RoundTeamPilot_ID
    LEFT JOIN PilotRatings pr ON pr.ID = rtp.Pilot_Rating_ID
  `);

  // Fetch all flights
  const flightResult = await pool.request().query(`
    SELECT f.ID, f.PilotID, f.RoundID, f.DateTime, f.Distance, f.url, f.ScoringType,
           f.isManualLog, f.ManualLogJustification,
           f.IsOverallPB, f.AwardedOverallPB,
           f.IsUKPersonalBest, f.AwardedUKPersonalBest,
           f.IsFirstXC, f.AwardedFirstXC,
           f.IsFirstUKXC, f.AwardedFirstUKXC,
           f.roundTeamPlace_ID AS RTPPlaceID,
           rp.RoundTeam_ID
    FROM Flights f
    LEFT JOIN RoundTeamPlaces rp ON rp.ID = f.roundTeamPlace_ID
  `);

  // Index structures for fast lookups
  const rtByRound = new Map();          // RoundID → RoundTeam[]
  const rtpByRoundTeam = new Map();     // RoundTeam.ID → RoundTeamPlace[]
  const flightByPlace = new Map();      // RoundTeamPlace.ID → Flight
  const flightByRoundPilot = new Map(); // `${roundId}:${pilotSqlId}` → Flight

  for (const r of rtResult.recordset) {
    if (!rtByRound.has(r.RoundID)) rtByRound.set(r.RoundID, []);
    rtByRound.get(r.RoundID).push(r);
    teamUuid.set(r.ID, getOrCreateUuid("roundTeam", r.ID));
  }
  for (const r of rtpResult.recordset) {
    if (!rtpByRoundTeam.has(r.RoundTeam_ID)) rtpByRoundTeam.set(r.RoundTeam_ID, []);
    rtpByRoundTeam.get(r.RoundTeam_ID).push(r);
  }
  for (const f of flightResult.recordset) {
    if (f.RTPPlaceID) flightByPlace.set(f.RTPPlaceID, f);
    flightByRoundPilot.set(`${f.RoundID}:${f.PilotID}`, f);
  }

  const roundsSummary = [];
  /** @type {Map<string, object>} uuid → full round doc (for step 10) */
  const roundDocs = new Map();
  // Legacy-score manifest (keyed by LEGACY ids) — captures the preserved-verbatim
  // legacy PilotPoints/TeamScore for every Complete round so validate.mjs can
  // prove migrated == legacy. See legacy-score-manifest.mjs for the shape.
  /** @type {Record<string, Record<string, {teamScore:number, pilots:Record<string, number>}>>} */
  const legacyScoreManifest = {};

  for (const r of roundsResult.recordset) {
    const id = getOrCreateUuid("round", r.ID);
    roundUuid.set(r.ID, id);

    const siteId = r.SiteID ? siteUuid.get(r.SiteID) : null;
    const orgClubId = r.OrganisingClub_ID ? clubUuid.get(r.OrganisingClub_ID) : null;
    const orgClub = orgClubId
      ? clubsList.find((c) => c.id === orgClubId)
      : null;
    const seasonYear = r.SeasonYear ?? null;

    // Build teams
    const roundTeamRows = rtByRound.get(r.ID) ?? [];
    const teams = roundTeamRows.map((rt) => {
      const rtId = teamUuid.get(rt.ID);
      const clubId = rt.ClubID ? clubUuid.get(rt.ClubID) : null;
      const clubDoc = clubId ? clubsList.find((c) => c.id === clubId) : null;

      const places = (rtpByRoundTeam.get(rt.ID) ?? []).sort((a, b) => a.PlaceInTeam - b.PlaceInTeam);

      const legacySignatures = [];

      const pilots = places.map((place) => {
        const pilotSqlId = place.Pilot_ID ?? null;
        const pilotId = pilotSqlId ? pilotUuid.get(pilotSqlId) : null;
        const hasPilot = !!place.RoundTeamPilot_ID;

        // Flight — try place-based lookup first, fall back to round+pilot
        const flight = place.ID
          ? (flightByPlace.get(place.ID) ?? (pilotSqlId ? flightByRoundPilot.get(`${r.ID}:${pilotSqlId}`) : null))
          : (pilotSqlId ? flightByRoundPilot.get(`${r.ID}:${pilotSqlId}`) : null);

        const snapshot = hasPilot
          ? {
              wingClass: normalizeWingClass(place.WingClass, tally) ?? "EN B",
              pilotRating: normalizePilotRating(place.PilotRatingDesc, tally) ?? "Pilot",
              ...(place.PhoneNumber ? { phoneNumber: place.PhoneNumber } : {}),
              ...(place.HelmetColour ? { helmetColour: place.HelmetColour } : {}),
              ...(place.HarnessType ? { harnessType: place.HarnessType } : {}),
              ...(place.HarnessColour ? { harnessColour: place.HarnessColour } : {}),
              ...(place.Manufacturer_ID ? { wingManufacturer: mfrNameBySqlId.get(place.Manufacturer_ID) ?? null } : {}),
              ...(place.WingModel ? { wingModel: place.WingModel } : {}),
              ...(place.WingColours ? { wingColours: place.WingColours } : {}),
              ...(place.EmergencyContactName ? { emergencyContactName: place.EmergencyContactName } : {}),
              ...(place.EmergencyPhoneNumber ? { emergencyPhoneNumber: place.EmergencyPhoneNumber } : {}),
              ...(place.MedicalInfo ? { medicalInfo: place.MedicalInfo } : {}),
            }
          : null;

        const flightDoc = flight
          ? {
              id: getOrCreateUuid("flight", flight.ID),
              distance: Number(flight.Distance) || 0,
              url: flight.url ?? null,
              dateTime: flight.DateTime ? new Date(flight.DateTime).toISOString() : null,
              scoringType: normalizeScoringType(flight.ScoringType, tally) ?? "XC",
              // Legacy Flights persist no per-flight handicap score or wing
              // factor (only Distance). The new engine derives them, but
              // migration PRESERVES legacy scores at the slot (pilotPoints) and
              // team (score) level and NEVER recomputes, so these stay at their
              // neutral defaults for migrated rounds.
              score: 0,
              wingFactor: 1.0,
              isManualLog: !!flight.isManualLog,
              ...(flight.ManualLogJustification ? { manualLogJustification: flight.ManualLogJustification } : {}),
              ...(flight.IsFirstXC ? { isFirstXC: true } : {}),
              ...(flight.IsFirstUKXC ? { isFirstUKXC: true } : {}),
              ...(flight.IsUKPersonalBest ? { isUKPersonalBest: true } : {}),
              ...(flight.IsOverallPB ? { isOverallPB: true } : {}),
              ...(flight.AwardedFirstXC ? { awardedFirstXC: true } : {}),
              ...(flight.AwardedFirstUKXC ? { awardedFirstUKXC: true } : {}),
              ...(flight.AwardedUKPersonalBest ? { awardedUKPB: true } : {}),
              ...(flight.AwardedOverallPB ? { awardedOverallPB: true } : {}),
            }
          : null;

        if (hasPilot && !!place.SignToFly && pilotId) {
          legacySignaturesStamped++;
          legacySignatures.push(legacyMigratedSignature({
            roundId: id,
            teamId: rtId,
            place: place.PlaceInTeam,
            pilotId,
            stableKey: `${id}-${rtId}-${place.PlaceInTeam}`,
            legacyId: place.RoundTeamPilot_ID,
          }));
        }

        return {
          placeInTeam: place.PlaceInTeam,
          isScoring: !!place.IsScoring,
          status: hasPilot ? "Filled" : "Empty",
          accountedFor: hasPilot ? !!place.AccountedFor : false,
          signToFly: hasPilot ? !!place.SignToFly : false,
          noScore: hasPilot ? !!place.noScore : false,
          pilotPoints: hasPilot ? (Number(place.PilotPoints) || 0) : 0,
          pilotId,
          snapshot,
          flight: flightDoc,
        };
      });

      if (!clubDoc) fallbackClubTeams++;

      return {
        id: rtId,
        // Legacy RoundTeam.ID — lets validate.mjs match this migrated team blob
        // back to the legacy-score manifest by (round.legacyId, team.legacyId,
        // slot.placeInTeam). Team.legacyId is optional in the schema/types.
        legacyId: rt.ID,
        teamName: ensureNonEmpty(rt.TeamName, "Unknown team"),
        club: clubDoc ? { id: clubDoc.id, name: clubDoc.name } : { id: "legacy-no-club", name: "Unknown club" },
        score: Number(rt.TeamScore) || 0,
        ...(rt.PureTrackGroup_ID ? { pureTrackGroupId: rt.PureTrackGroup_ID } : {}),
        ...(rt.PureTrackGroupSlug ? { pureTrackGroupSlug: rt.PureTrackGroupSlug } : {}),
        pilots,
        __legacySignatures: legacySignatures,
      };
    });

    const signaturesToWrite = [];
    for (const team of teams) {
      signaturesToWrite.push(...team.__legacySignatures);
      delete team.__legacySignatures;
    }

    const status = mapStatus(r.StatusDesc, tally);
    if (!siteId) sentinelSiteRounds++;

    const roundDoc = {
      id,
      legacyId: r.ID,
      date: r.Date ? new Date(r.Date).toISOString().slice(0, 10) : null,
      status,
      isLocked: !!r.isLocked,
      maxTeams: r.MaxTeams ?? 8,
      minimumScore: r.MinimumScore ?? 0,
      ...(r.PureTrackGroup_ID ? { pureTrackGroupId: r.PureTrackGroup_ID } : {}),
      ...(r.PureTrackGroupName && r.PureTrackGroupName !== "Not set yet..."
        ? { pureTrackGroupName: r.PureTrackGroupName }
        : {}),
      ...(r.PureTrackGroupSlug && r.PureTrackGroupSlug !== "Not set yet..."
        ? { pureTrackGroupSlug: r.PureTrackGroupSlug }
        : {}),
      site: {
        id: siteId ?? "legacy-no-site",
        name: ensureNonEmpty(r.SiteName, "Unknown site"),
        ...(r.ParkingW3W ? { parkingW3W: r.ParkingW3W } : {}),
        ...(r.BriefingW3W ? { briefingW3W: r.BriefingW3W } : {}),
        ...(r.TakeOffW3W ? { takeOffW3W: r.TakeOffW3W } : {}),
      },
      ...(orgClub ? { organisingClub: { id: orgClub.id, name: orgClub.name } } : {}),
      season: { year: seasonYear },
      teams,
    };

    await uploadPrivateBlob(`rounds/${id}.json`, roundDoc);

    for (const signature of signaturesToWrite) {
      await uploadPrivateBlob(
        legacySignaturePath(signature.roundId, signature.teamId, signature.place),
        signature,
      );
    }

    // Preserve legacy scores VERBATIM for completed rounds (plan D5 / Oracle O9).
    // The imported legacy PilotPoints (slot.pilotPoints, read above from
    // RoundTeamPilot.PilotPoints) and TeamScore (team.score, from
    // RoundTeam.TeamScore) are written to the blob EXACTLY as legacy persisted
    // them — we do NOT re-score with the new engine, because re-migrating with
    // the new engine could shift historical scores. Instead we record the legacy
    // scores (keyed by legacy ids) into the manifest so validate.mjs can assert
    // migrated == legacy.
    if (status === "Complete") {
      const teamManifest = {};
      for (const team of teams) {
        const pilotPointsByPlace = {};
        for (const slot of team.pilots) {
          if (slot.status === "Filled") {
            pilotPointsByPlace[slot.placeInTeam] = slot.pilotPoints;
          }
        }
        teamManifest[team.legacyId] = {
          teamScore: team.score,
          pilots: pilotPointsByPlace,
        };
      }
      legacyScoreManifest[roundDoc.legacyId] = teamManifest;
    }

    // Retain in memory for step 10 league/results computation
    roundDocs.set(id, roundDoc);

    roundsSummary.push({
      id,
      legacyId: r.ID,
      date: roundDoc.date,
      siteId: siteId ?? null,
      siteName: r.SiteName ?? "",
      status,
      seasonYear,
    });

    // Link round → season
    if (r.Season_ID) {
      const season = seasonsList.find((s) => s.legacyId === r.Season_ID);
      if (season && !season.rounds.includes(id)) season.rounds.push(id);
    }
  }

  await uploadBlob("rounds.json", roundsSummary);
  saveIdMap();
  console.log(`  wrote ${roundsSummary.length} rounds\n`);

  // Persist the legacy-score manifest (migration's own artifact, keyed by legacy
  // ids). validate.mjs reads it to prove every migrated Complete round kept its
  // exact legacy PilotPoints/TeamScore. Written for both real and --dry-run runs
  // (like id-map / normalization-counts) since it is migration state, not a blob.
  writeLegacyScoreManifest(legacyScoreManifest);
  const manifestRoundCount = Object.keys(legacyScoreManifest).length;
  console.log(`  wrote legacy-score manifest for ${manifestRoundCount} Complete round(s) → ${legacyScoreManifestPath()}\n`);

  const pilotNameMap = Object.fromEntries(pilotsSummary.map((p) => [p.id, p.name]));

  // ── 10. Round briefs ────────────────────────────────────────────────────────
  console.log("Step 10: round-briefs/{uuid}.json");
  const briefResult = await pool.request().query(`
    SELECT rb.ID, rb.RoundID, rb.SiteName, rb.BrieferName,
           rb.BrieferBHPA_CoachLevel, rb.BrieferBHPA_Number, rb.BrieferPhoneNumber,
           rb.BrieferEmailAddress, rb.RoundDate, rb.OrganisingClubName,
           rb.BriefingTime, rb.LandByTime, rb.CheckInByTime,
           rb.NumTeamsInRound, rb.NumPilotsInRound,
           rb.WindSpeed_Direction, rb.DirectionOfFlight, rb.ExpectedLandingArea,
           rb.AirspaceAndHazards, rb.NOTAMs, rb.BENO_LineDescription, rb.BriefersNotes,
           rb.Image
    FROM RoundBriefs rb
  `);
  let briefCount = 0;
  for (const r of briefResult.recordset) {
    const roundId = roundUuid.get(r.RoundID);
    if (!roundId) continue;
    const roundDoc = roundDocs.get(roundId);
    const imageBytes = briefImageBlobFromLegacy(r.Image);
    const imagePaths = imageBytes ? [briefImagePath(roundId)] : [];
    if (imageBytes) {
      await uploadPrivateBinaryBlob(imagePaths[0], imageBytes, "image/png");
    }
    const generatedAt = new Date().toISOString();
    const briefDate = r.RoundDate ? new Date(r.RoundDate).toISOString().slice(0, 10) : roundDoc?.date;
    const brieferCoachRaw = r.BrieferBHPA_CoachLevel;
    const brieferCoachLevel = normalizeCoachType(brieferCoachRaw, tally);
    const freqMhz = freqMhzByYearClub.get(`${roundDoc?.season?.year}:${roundDoc?.organisingClub?.id}`);
    if (freqMhz != null) briefsFrequencyMhz++;
    const brief = {
      roundId,
      generatedAt,
      date: ensureNonEmpty(briefDate, generatedAt.slice(0, 10)),
      siteName: ensureNonEmpty(r.SiteName ?? roundDoc?.site?.name, "Unknown site"),
      ...(roundDoc?.site?.parkingW3W ? { parkingW3W: roundDoc.site.parkingW3W } : {}),
      ...(roundDoc?.site?.briefingW3W ? { briefingW3W: roundDoc.site.briefingW3W } : {}),
      ...(roundDoc?.site?.takeOffW3W ? { takeOffW3W: roundDoc.site.takeOffW3W } : {}),
      ...(r.BriefingTime ? { briefingTime: new Date(r.BriefingTime).toTimeString().slice(0, 5) } : {}),
      ...(r.LandByTime ? { landByTime: new Date(r.LandByTime).toTimeString().slice(0, 5) } : {}),
      ...(r.CheckInByTime ? { checkInByTime: new Date(r.CheckInByTime).toTimeString().slice(0, 5) } : {}),
      ...(r.OrganisingClubName ? { organisingClubName: r.OrganisingClubName } : {}),
      ...(roundDoc?.pureTrackGroupName ? { pureTrackGroupName: roundDoc.pureTrackGroupName } : {}),
      ...(roundDoc?.pureTrackGroupSlug ? { pureTrackGroupSlug: roundDoc.pureTrackGroupSlug } : {}),
      ...(r.WindSpeed_Direction ? { windSpeedDirection: r.WindSpeed_Direction } : {}),
      ...(r.DirectionOfFlight ? { directionOfFlight: r.DirectionOfFlight } : {}),
      ...(r.ExpectedLandingArea ? { expectedLandingArea: r.ExpectedLandingArea } : {}),
      ...(r.AirspaceAndHazards ? { airspaceAndHazards: r.AirspaceAndHazards } : {}),
      ...(r.NOTAMs ? { NOTAMs: r.NOTAMs } : {}),
      ...(r.BENO_LineDescription ? { BENO_LineDescription: r.BENO_LineDescription } : {}),
      ...(r.BriefersNotes ? { briefersNotes: r.BriefersNotes } : {}),
      ...(freqMhz != null ? { frequencyMhz: freqMhz } : {}),
      briefer: {
        ...(r.BrieferName ? { name: r.BrieferName } : {}),
        ...(brieferCoachLevel ? { bhpaCoachLevel: brieferCoachLevel } : {}),
        ...(r.BrieferBHPA_Number ? { bhpaNumber: r.BrieferBHPA_Number } : {}),
        ...(r.BrieferPhoneNumber ? { phoneNumber: r.BrieferPhoneNumber } : {}),
        ...(r.BrieferEmailAddress ? { emailAddress: r.BrieferEmailAddress } : {}),
      },
      ...(imagePaths.length > 0 ? { imagePaths } : {}),
      teams: (roundDoc?.teams ?? []).map((team) => ({
        teamName: team.teamName,
        clubName: team.club?.name ?? "",
        ...(team.pureTrackGroupId ? { pureTrackGroupId: team.pureTrackGroupId } : {}),
        ...(team.pureTrackGroupSlug ? { pureTrackGroupSlug: team.pureTrackGroupSlug } : {}),
        pilots: team.pilots
          .filter((pilot) => pilot.pilotId && pilot.snapshot)
          .map((pilot) => ({
            placeInTeam: pilot.placeInTeam,
            pilotId: pilot.pilotId,
            name: pilot.pilotId ? (pilotNameMap[pilot.pilotId] ?? pilot.pilotId) : "Unknown",
            isScoring: pilot.isScoring,
            snapshot: pilot.snapshot,
          })),
      })),
    };
    await uploadPrivateBlob(`round-briefs/${roundId}.json`, brief);
    briefCount++;
  }
  saveIdMap();
  console.log(`  wrote ${briefCount} round briefs\n`);

  // ── 9b. RoundClubPilot (count only — not migrated to blobs) ────────────────
  //
  // Decision: Option (b) — redundant / discard with audit trail.
  // See docs/runbooks/round-club-pilot-decision.md for full rationale.
  //
  // RoundClubPilot is the pre-team-assignment registration queue: pilots who
  // registered under a club but were not yet assigned to a specific team slot.
  // Any promoted pilot already has a RoundTeamPilot row captured in Step 8.
  // Surplus (never-promoted) pilots had no flights and did not affect scoring.
  // All pilot safety data is migrated via pilots/{uuid}.json in Step 7.
  //
  // We count the rows for reconciliation audit and write no blobs.
  console.log("Step 9b: RoundClubPilot (count only — not migrated)");
  const rcpResult = await pool.request().query("SELECT COUNT(*) AS cnt FROM RoundClubPilots");
  const rcpCount = Number(rcpResult.recordset[0]?.cnt ?? 0);
  console.log(
    `  RoundClubPilot: ${rcpCount} rows analyzed as redundant with RoundTeamPilot data — not migrated`
  );
  writeDiscardedCounts({ roundClubPilot: rcpCount });
  console.log("");

  // ── 11. Recompute seasons/{year}.json and results/{year}.json ───────────────
  console.log("Step 11: recompute seasons/{year}.json + results/{year}.json");

  for (const season of seasonsList) {
    // Collect in-memory round docs for this season
    const seasonRoundDocs = season.rounds
      .map((id) => roundDocs.get(id))
      .filter(Boolean);

    // computeLeague is the imported @bccweb/scoring engine (windows the top
    // leagueRoundScoresCounted rounds under config); pass the migrated config.
    const leagueTable = computeLeague(seasonRoundDocs, config);
    season.leagueTable = leagueTable;

    await uploadBlob(`seasons/${season.year}.json`, {
      id: season.id,
      year: season.year,
      active: season.active,
      rounds: season.rounds,
      leagueTable,
    });

    // results/{year}.json — per-round results
    const results = buildSeasonResults(season, roundDocs, pilotNameMap);
    await uploadBlob(`results/${season.year}.json`, results);

    console.log(
      `  season ${season.year}: ${leagueTable.length} teams in league, ${results.length} round results`
    );
  }

  await pool.close();
  saveIdMap();

  const sortObject = (obj) => Object.fromEntries(
    Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)),
  );
  const normalizationCounts = {
    driftFixes: sortObject({
      briefsFrequencyMhz,
      fallbackClubTeams,
      legacySignaturesStamped,
      nonEmptyPersonNameFixes,
      sentinelSiteRounds,
    }),
    normalization: sortObject(
      Object.fromEntries(
        Object.entries(tally).map(([field, counts]) => [field, sortObject(counts)]),
      ),
    ),
  };
  writeNormalizationCounts(normalizationCounts);
  console.log("\nMigration normalization summary:");
  console.log("  driftFixes:");
  for (const [name, count] of Object.entries(normalizationCounts.driftFixes)) {
    console.log(`    ${name}: ${count}`);
  }
  console.log("  normalization:");
  for (const [field, counts] of Object.entries(normalizationCounts.normalization)) {
    const parts = Object.entries(counts).map(([name, count]) => `${name}=${count}`).join(", ");
    console.log(`    ${field}: ${parts}`);
  }
  console.log("\nMigration complete.");
}

// ─── Season aggregation (computeLeague imported; buildSeasonResults copied) ──
//
// There is deliberately NO scoreRound copy here: migration PRESERVES legacy
// per-round scores verbatim (see the round loop above) and never recomputes
// them, so the former scoreRound port was dead and has been removed.
//
// computeLeague is IMPORTED from @bccweb/scoring (see the import at the top of
// this file) rather than copied — it resolves cleanly from this standalone
// package via the workspace root node_modules, so the migrated league snapshot
// stays in lockstep with the engine the API runs (no divergent duplicate). It
// aggregates the already-final PRESERVED legacy team.score values; it does NOT
// re-derive per-round scores. The API re-derives the league on its next
// recompute, so this snapshot is provisional.
//
// buildSeasonResults (below) has NO @bccweb export to import — it lives in
// apps/api/src/lib/recompute.ts (an app module, not a published package) — so it
// necessarily remains a migration-local copy. Keep its field names/shape in
// lockstep with recompute.ts (it likewise reads the PRESERVED legacy team.score /
// slot.pilotPoints and never recomputes them).

// ─── buildSeasonResults — copy of apps/api/src/lib/recompute.ts ──────────────

/**
 * Build results/{year}.json content from in-memory round docs.
 *
 * Migration-local copy of apps/api/src/lib/recompute.ts buildSeasonResults —
 * see the season-aggregation note above (buildSeasonResults has no package export
 * to import, unlike computeLeague). It reads the PRESERVED legacy team.score /
 * slot.pilotPoints (never recomputed) and emits pilotId in lockstep with
 * recompute.ts. Keep field names/shape aligned with recompute.ts.
 *
 * @param {object}            season       Season record (has .rounds array of UUIDs)
 * @param {Map<string,object>} allRoundDocs uuid → round doc
 * @param {Record<string,string>} pilotNameMap pilotId → display name
 * @returns {object[]}
 */
function buildSeasonResults(season, allRoundDocs, pilotNameMap) {
  const completeRounds = season.rounds
    .map((id) => allRoundDocs.get(id))
    .filter((r) => r && r.status === "Complete")
    .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));

  return completeRounds.map((round) => ({
    roundId: round.id,
    date: round.date,
    siteName: round.site.name,
    teamResults: round.teams
      .sort((a, b) => b.score - a.score)
      .map((team, i) => ({
        rank: i + 1,
        teamName: team.teamName,
        clubName: team.club.name,
        score: team.score,
        pilots: team.pilots
          .filter((p) => p.flight != null && p.snapshot != null)
          .sort((a, b) => b.pilotPoints - a.pilotPoints)
          .map((slot) => ({
            pilotId: slot.pilotId ?? null,
            pilotName: slot.pilotId
              ? (pilotNameMap[slot.pilotId] ?? slot.pilotId)
              : "Unknown",
            distance: slot.flight.distance,
            score: slot.pilotPoints,
            wingClass: slot.snapshot.wingClass,
          })),
      })),
  }));
}

// ─── Run ─────────────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("\nMigration failed:", err.message);
    console.error(err.stack);
    process.exit(1);
  });
}
