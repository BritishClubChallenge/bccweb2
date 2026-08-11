#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * validate.mjs
 *
 * Post-migration validation: verifies expected blobs, scans public JSON for PII,
 * and mirrors the API read path by parsing produced blobs through
 * @bccweb/schemas. The gate imports @bccweb/schemas by package name (whose `main`
 * resolves to packages/schemas/dist via the workspace root node_modules), so run
 * `make build` before this validator.
 *
 * Usage:
 *   BLOB_CONNECTION_STRING="DefaultEndpointsProtocol=https;AccountName=...;..."  \
 *   node scripts/migrate/validate.mjs
 *
 * Or use the invoking operator/OIDC identity:
 *   BLOB_STORAGE_ACCOUNT_NAME="stbccwebstagingdata" node scripts/migrate/validate.mjs
 *
 * Against Azurite:
 *   BLOB_CONNECTION_STRING="UseDevelopmentStorage=true" \
 *   node scripts/migrate/validate.mjs
 *
 * Exit code 0 = all checks passed.
 * Exit code 1 = one or more checks failed (see output for details).
 */

import { pathToFileURL } from "node:url";

import { findPiiInObject, PII_FIELDS } from "../lib/pii.mjs";
import { createBlobServiceClient } from "./blobClient.mjs";
import { legacyScoreManifestPath, readLegacyScoreManifest } from "./legacy-score-manifest.mjs";

const PUBLIC_CONTAINER = process.env.BLOB_CONTAINER_NAME ?? process.env.BLOB_CONTAINER ?? "data";
const PRIVATE_CONTAINER = process.env.BLOB_PRIVATE_CONTAINER_NAME ?? process.env.BLOB_PRIVATE_CONTAINER ?? "data-private";

// Null → "" coercions from healed(z.string(), "") for legacy missing FKs.
export const EXPECTED_HEALS = new Set(["sites:clubId", "rounds:siteId"]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function ok(msg) {
  console.log(`  ✓  ${msg}`);
  passed++;
}

function fail(msg) {
  console.error(`  ✗  ${msg}`);
  failed++;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function childPath(parent, child) {
  if (typeof child === "number") {
    return `${parent}[${child}]`;
  }
  return parent ? `${parent}.${child}` : child;
}

function normalizeKeyPath(path) {
  return path.replaceAll(/\[\d+\]/g, "").replaceAll("..", ".").replace(/^\./u, "").replace(/\.$/u, "");
}

function valuesMatch(raw, parsed) {
  return Object.is(raw, parsed);
}

/**
 * Directionally classifies schema read healing by walking RAW → PARSED.
 * - strip: key/index existed in RAW and disappeared from parsed.
 * - change: key/index exists in both, but value changed.
 * - add/default: exists only in parsed and is intentionally ignored.
 *
 * @param {unknown} raw
 * @param {unknown} parsed
 * @param {string} [path]
 * @returns {{ strips: string[], changes: string[] }}
 */
export function classifyRawToParsed(raw, parsed, path = "") {
  const result = { strips: [], changes: [] };

  function walk(rawValue, parsedValue, currentPath) {
    if (valuesMatch(rawValue, parsedValue)) {
      return;
    }

    if (Array.isArray(rawValue)) {
      if (!Array.isArray(parsedValue)) {
        result.changes.push(currentPath);
        return;
      }

      rawValue.forEach((item, index) => {
        const itemPath = childPath(currentPath, index);
        if (index >= parsedValue.length) {
          result.strips.push(itemPath);
          return;
        }
        walk(item, parsedValue[index], itemPath);
      });
      return;
    }

    if (isRecord(rawValue)) {
      if (!isRecord(parsedValue)) {
        result.changes.push(currentPath);
        return;
      }

      Object.keys(rawValue).forEach((key) => {
        const keyPath = childPath(currentPath, key);
        if (!hasOwn(parsedValue, key)) {
          result.strips.push(keyPath);
          return;
        }
        walk(rawValue[key], parsedValue[key], keyPath);
      });
      return;
    }

    result.changes.push(currentPath);
  }

  walk(raw, parsed, path);
  return result;
}

/**
 * Download and JSON-parse a blob. Returns null (and records a failure) if the
 * blob does not exist or cannot be parsed.
 *
 * @param {import("@azure/storage-blob").ContainerClient} client
 * @param {string} path
 * @param {boolean} [required=true] If false, a missing blob is silently skipped.
 * @returns {Promise<unknown|null>}
 */
async function readBlob(client, path, required = true) {
  const blobClient = client.getBlockBlobClient(path);
  try {
    const buf = await blobClient.downloadToBuffer();
    try {
      return JSON.parse(buf.toString("utf-8"));
    } catch {
      fail(`${path} — invalid JSON`);
      return null;
    }
  } catch (err) {
    if (err.statusCode === 404) {
      if (required) fail(`${path} — blob not found (404)`);
      return null;
    }
    fail(`${path} — download error: ${err.message}`);
    return null;
  }
}

async function loadBuiltSchemas() {
  try {
    return await import("@bccweb/schemas");
  } catch (err) {
    console.error("Unable to import @bccweb/schemas from the built package.");
    console.error("Run `make build` from the repository root so packages/schemas/dist exists, then re-run this validator.");
    console.error(`Import error: ${err.message}`);
    process.exit(1);
  }
}

// ─── PII scan ─────────────────────────────────────────────────────────────────

async function scanPublicBlobForPii(client, path) {
  const parsed = await readBlob(client, path);
  if (parsed === null) {
    return;
  }

  const hits = findPiiInObject(parsed, PII_FIELDS);
  if (hits.length === 0) {
    ok(`${path} — no PII fields`);
    return;
  }

  for (const hit of hits) {
    fail(`${path} — PII field ${hit.field} at ${hit.path}`);
  }
}

/**
 * Assert that `value` is an array and optionally that it has at least `min`
 * items.
 *
 * @param {string} path Blob path (for error messages)
 * @param {unknown} value
 * @param {number} [min=1]
 * @returns {boolean}
 */
function assertArray(path, value, min = 1) {
  if (!Array.isArray(value)) {
    fail(`${path} — expected array, got ${typeof value}`);
    return false;
  }
  if (value.length < min) {
    fail(`${path} — array has ${value.length} items (expected ≥ ${min})`);
    return false;
  }
  ok(`${path} — ${value.length} items`);
  return true;
}

/**
 * Assert that `value` is a non-null object that has all `requiredKeys`.
 *
 * @param {string} path
 * @param {unknown} value
 * @param {string[]} requiredKeys
 * @returns {boolean}
 */
function assertObject(path, value, requiredKeys = []) {
  if (!isRecord(value)) {
    fail(`${path} — expected object`);
    return false;
  }
  const missing = requiredKeys.filter((key) => !hasOwn(value, key));
  if (missing.length) {
    fail(`${path} — missing fields: ${missing.join(", ")}`);
    return false;
  }
  ok(`${path} — object OK`);
  return true;
}

// Scoring config keys added by the W1 normalized-scoring reshape. The migrated
// config.json MUST carry all of these (taskMaxPoints, the counts, and the
// factor tables) or the new engine cannot score — assert them present + valid.
const REQUIRED_CONFIG_NUMBER_KEYS = [
  "maxTeamsInClub",
  "maxPilotsInTeam",
  "maxScoringPilotsInTeam",
  "maxPilotScoresCountedPerTeam",
  "leagueRoundScoresCounted",
  "taskMaxPoints",
];

const REQUIRED_CONFIG_FACTOR_TABLES = {
  wingFactors: ["EN A", "EN B", "EN C", "EN C 2-liner", "EN D", "EN D 2-liner"],
  pilotFactors: ["Club Pilot", "Pilot", "Advanced Pilot"],
  clubsAttendingFactors: ["fewerThanThreeClubs", "exactlyThreeClubs", "moreThanThreeClubs"],
  minDistanceFactors: ["oneFlight", "twoFlights", "threeFlights", "fourFlights", "fiveOrMoreFlights"],
};

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Assert the migrated config.json carries every scoring key the new engine needs
 * (counts, taskMaxPoints, and the four factor tables) with valid numeric values.
 *
 * @param {string} path
 * @param {unknown} config
 */
function assertScoringConfig(path, config) {
  if (!isRecord(config)) {
    fail(`${path} — config is not an object; cannot check scoring keys`);
    return;
  }
  let allOk = true;
  for (const key of REQUIRED_CONFIG_NUMBER_KEYS) {
    if (!hasOwn(config, key) || !isFiniteNumber(config[key])) {
      fail(`${path} — scoring config key ${key} missing or not a finite number`);
      allOk = false;
    }
  }
  for (const [table, keys] of Object.entries(REQUIRED_CONFIG_FACTOR_TABLES)) {
    const value = config[table];
    if (!isRecord(value)) {
      fail(`${path} — scoring factor table ${table} missing or not an object`);
      allOk = false;
      continue;
    }
    for (const factorKey of keys) {
      if (!isFiniteNumber(value[factorKey])) {
        fail(`${path} — scoring factor ${table}.${factorKey} missing or not a finite number`);
        allOk = false;
      }
    }
  }
  if (allOk) {
    ok(`${path} — scoring config keys present + valid (counts, taskMaxPoints, factor tables)`);
  }
}

// ─── Schema gate ──────────────────────────────────────────────────────────────

function schemaMaps(schemas) {
  return {
    public: [
      { family: "rounds", match: (path) => path === "rounds.json", schema: schemas.RoundSummarySchema.array(), schemaName: "RoundSummarySchema[]" },
      { family: "pilots", match: (path) => path === "pilots.json", schema: schemas.PilotSummarySchema.array(), schemaName: "PilotSummarySchema[]" },
      { family: "sites", match: (path) => path === "sites.json", schema: schemas.SiteSummarySchema.array(), schemaName: "SiteSummarySchema[]" },
      { family: "seasons", match: (path) => path === "seasons.json", schema: schemas.SeasonSummarySchema.array(), schemaName: "SeasonSummarySchema[]" },
      { family: "seasons", match: (path) => /^seasons\/[^/]+\.json$/u.test(path), schema: schemas.SeasonSchema, schemaName: "SeasonSchema" },
      { family: "clubs", match: (path) => path === "clubs.json", schema: schemas.ClubSummarySchema.array(), schemaName: "ClubSummarySchema[]" },
      { family: "club-teams", match: (path) => path === "club-teams.json", schema: schemas.ClubTeamSummarySchema.array(), schemaName: "ClubTeamSummarySchema[]" },
      { family: "manufacturers", match: (path) => path === "manufacturers.json", schema: schemas.ManufacturersIndexSchema, schemaName: "ManufacturersIndexSchema" },
    ],
    private: [
      { family: "rounds", match: (path) => /^rounds\/[^/]+\.json$/u.test(path), schema: schemas.RoundSchema, schemaName: "RoundSchema" },
      { family: "pilots", match: (path) => /^pilots\/[^/]+\.json$/u.test(path), schema: schemas.PilotSchema, schemaName: "PilotSchema" },
      { family: "round-briefs", match: (path) => /^round-briefs\/[^/]+\.json$/u.test(path), schema: schemas.BriefSchema, schemaName: "BriefSchema" },
      { family: "signatures", match: (path) => /^signatures\/.+\.json$/u.test(path), schema: schemas.SignatureLedgerSchema, schemaName: "SignatureLedgerSchema" },
      { family: "clubs", match: (path) => /^clubs\/[^/]+\.json$/u.test(path), schema: schemas.ClubSchema, schemaName: "ClubSchema" },
      { family: "club-teams", match: (path) => /^club-teams\/[^/]+\.json$/u.test(path), schema: schemas.ClubTeamSchema, schemaName: "ClubTeamSchema" },
      { family: "sites", match: (path) => /^sites\/[^/]+\.json$/u.test(path), schema: schemas.SiteSchema, schemaName: "SiteSchema" },
      { family: "season-clubs", match: (path) => /^season-clubs\/[^/]+\/(?!index\.json$)[^/]+\.json$/u.test(path), schema: schemas.SeasonClubSchema, schemaName: "SeasonClubSchema" },
      { family: "config", match: (path) => path === "config.json", schema: schemas.ConfigSchema, schemaName: "ConfigSchema" },
    ],
  };
}

function unvalidatedReason(path) {
  if (/^results\//u.test(path)) return "results have no schema";
  if (/(?:^|\/)club-history\.json$/u.test(path)) return "club history has no schema";
  if (/^season-clubs\/index\.json$/u.test(path) || /^season-clubs\/[^/]+\/index\.json$/u.test(path)) return "season-club index has no schema";
  if (path === "user-index.json" || /^users\//u.test(path) || /^auth\//u.test(path)) return "auth/user blobs are outside the migration schema gate";
  return "no schema mapping";
}

function issuePath(issue) {
  if (!issue.path || issue.path.length === 0) {
    return "<root>";
  }
  return issue.path.map((part) => (typeof part === "number" ? `[${part}]` : String(part))).join(".").replaceAll(".[", "[");
}

function healKey(family, keyPath) {
  return `${family}:${normalizeKeyPath(keyPath)}`;
}

export function evaluateSchemaParse({ family, schema, raw, expectedHeals = EXPECTED_HEALS }) {
  const parsed = schema.safeParse(raw);

  if (!parsed.success) {
    return {
      validated: false,
      rejects: parsed.error.issues.map((issue) => issuePath(issue)),
      strips: [],
      heals: [],
    };
  }

  const diff = classifyRawToParsed(raw, parsed.data);
  return {
    validated: true,
    rejects: [],
    strips: diff.strips.map((keyPath) => normalizeKeyPath(keyPath)),
    heals: diff.changes.map((keyPath) => ({
      keyPath: normalizeKeyPath(keyPath),
      allowed: expectedHeals.has(healKey(family, keyPath)),
    })),
  };
}

function newSchemaStats() {
  return {
    validated: 0,
    rejects: [],
    strips: [],
    heals: new Map(),
    unexpectedHeals: [],
    unvalidated: [],
  };
}

function recordHeal(stats, family, keyPath, path, allowed) {
  const normalized = normalizeKeyPath(keyPath);
  const key = `${family}.${normalized}`;
  const current = stats.heals.get(key) ?? { count: 0, allowed, paths: new Set() };
  current.count++;
  current.paths.add(path);
  stats.heals.set(key, current);
  if (!current.allowed) {
    stats.unexpectedHeals.push({ family, keyPath: normalized, path });
  }
}

async function validateBlobWithSchema(containerName, path, raw, mapping, stats) {
  const result = evaluateSchemaParse({ family: mapping.family, schema: mapping.schema, raw });

  if (!result.validated) {
    result.rejects.forEach((rejectPath) => stats.rejects.push({ containerName, family: mapping.family, path, issuePath: rejectPath }));
    return;
  }

  stats.validated++;
  result.strips.forEach((keyPath) => stats.strips.push({ containerName, family: mapping.family, path, keyPath }));
  result.heals.forEach((heal) => recordHeal(stats, mapping.family, heal.keyPath, path, heal.allowed));
}

async function runSchemaGate(containerName, client, mappings, stats) {
  for await (const blob of client.listBlobsFlat()) {
    if (!blob.name.endsWith(".json")) {
      continue;
    }

    const mapping = mappings.find((candidate) => candidate.match(blob.name));
    if (!mapping) {
      stats.unvalidated.push({ containerName, path: blob.name, reason: unvalidatedReason(blob.name) });
      continue;
    }

    const raw = await readBlob(client, blob.name);
    if (raw !== null) {
      await validateBlobWithSchema(containerName, blob.name, raw, mapping, stats);
    }
  }
}

function printSchemaSummary(stats) {
  console.log("");
  console.log("── Schema parse gate summary ──");
  console.log(`  Validated: ${stats.validated}`);
  console.log(`  Rejects: ${stats.rejects.length}`);
  console.log(`  Strips: ${stats.strips.length}`);

  for (const reject of stats.rejects) {
    fail(`REJECT ${reject.containerName}/${reject.path} — ${reject.family} issue at ${reject.issuePath}`);
  }

  for (const strip of stats.strips) {
    fail(`STRIP ${strip.containerName}/${strip.path} — ${strip.family}.${strip.keyPath}`);
  }

  if (stats.heals.size === 0) {
    ok("schema heals — none");
  } else {
    for (const [key, heal] of [...stats.heals.entries()].sort()) {
      const status = heal.allowed ? "allowlisted" : "UNEXPECTED";
      const message = `CHANGE ${key} — ${heal.count} heal(s), ${status}`;
      if (heal.allowed) {
        ok(message);
      } else {
        fail(message);
      }
    }
  }

  for (const note of stats.unvalidated) {
    console.log(`  ⚠  unvalidated ${note.containerName}/${note.path} — ${note.reason}`);
  }
}

// ─── Legacy-score manifest cross-check ─────────────────────────────────────────

/**
 * Prove that migrated Complete rounds kept their EXACT legacy scores. Reads the
 * migration's legacy-score manifest (keyed by legacy ids) and asserts, for every
 * migrated Complete round, that each team's `team.score` AND each filled slot's
 * `pilotPoints` equal the manifest — matched by
 * `(round.legacyId, team.legacyId, slot.placeInTeam)`.
 *
 * A missing match key (round.legacyId, team.legacyId, or a slot placeInTeam not
 * present in the manifest) is a HARD FAILURE, never a silent skip — otherwise a
 * dropped legacyId would let a re-scored (mismatched) round slip through.
 *
 * @param {import("@azure/storage-blob").ContainerClient} privateClient
 * @param {Array<{id:string,status:string}>} roundsSummary  rounds.json entries
 */
async function crossCheckLegacyScores(privateClient, roundsSummary) {
  const manifest = readLegacyScoreManifest();
  const completeRounds = roundsSummary.filter((r) => isRecord(r) && r.status === "Complete");

  if (manifest === null) {
    if (completeRounds.length > 0) {
      fail(
        `legacy-score manifest missing at ${legacyScoreManifestPath()} but ${completeRounds.length} Complete round(s) exist — cannot prove legacy scores were preserved`,
      );
    } else {
      ok("legacy-score manifest — no Complete rounds to cross-check");
    }
    return;
  }

  if (completeRounds.length === 0) {
    ok("legacy-score manifest — no Complete rounds to cross-check");
    return;
  }

  for (const summary of completeRounds) {
    const doc = await readBlob(privateClient, `rounds/${summary.id}.json`);
    if (!isRecord(doc)) continue; // readBlob already recorded the failure

    const roundLegacyId = doc.legacyId;
    if (roundLegacyId == null) {
      fail(`data-private/rounds/${summary.id}.json — round.legacyId absent; cannot match legacy-score manifest`);
      continue;
    }
    const roundManifest = manifest[roundLegacyId];
    if (!isRecord(roundManifest)) {
      fail(`data-private/rounds/${summary.id}.json — no legacy-score manifest entry for round legacyId ${roundLegacyId}`);
      continue;
    }

    const teams = Array.isArray(doc.teams) ? doc.teams : [];
    for (const team of teams) {
      const teamLegacyId = isRecord(team) ? team.legacyId : undefined;
      if (teamLegacyId == null) {
        fail(`data-private/rounds/${summary.id}.json — team "${isRecord(team) ? team.teamName ?? "?" : "?"}" has no legacyId; cannot match legacy-score manifest`);
        continue;
      }
      const teamManifest = roundManifest[teamLegacyId];
      if (!isRecord(teamManifest)) {
        fail(`data-private/rounds/${summary.id}.json — no legacy-score manifest entry for round ${roundLegacyId} team ${teamLegacyId}`);
        continue;
      }

      if (Object.is(team.score, teamManifest.teamScore)) {
        ok(`round ${roundLegacyId} team ${teamLegacyId} — team.score preserved (${team.score})`);
      } else {
        fail(`data-private/rounds/${summary.id}.json — team ${teamLegacyId} score ${team.score} ≠ legacy manifest teamScore ${teamManifest.teamScore} (legacy score not preserved)`);
      }

      const pilotsManifest = isRecord(teamManifest.pilots) ? teamManifest.pilots : {};
      const filledSlots = (Array.isArray(team.pilots) ? team.pilots : []).filter(
        (slot) => isRecord(slot) && slot.status === "Filled",
      );
      for (const slot of filledSlots) {
        const place = slot.placeInTeam;
        if (place == null || !hasOwn(pilotsManifest, String(place))) {
          fail(`data-private/rounds/${summary.id}.json — team ${teamLegacyId} filled place ${place} absent from legacy-score manifest match keys`);
          continue;
        }
        if (Object.is(slot.pilotPoints, pilotsManifest[place])) {
          ok(`round ${roundLegacyId} team ${teamLegacyId} place ${place} — pilotPoints preserved (${slot.pilotPoints})`);
        } else {
          fail(`data-private/rounds/${summary.id}.json — team ${teamLegacyId} place ${place} pilotPoints ${slot.pilotPoints} ≠ legacy manifest ${pilotsManifest[place]} (legacy score not preserved)`);
        }
      }
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const blobService = createBlobServiceClient();
  const schemas = await loadBuiltSchemas();
  const maps = schemaMaps(schemas);
  const publicClient = blobService.getContainerClient(PUBLIC_CONTAINER);
  const privateClient = blobService.getContainerClient(PRIVATE_CONTAINER);

  console.log("BCCWeb Migration Validator");
  console.log(`  Public container: ${PUBLIC_CONTAINER}`);
  console.log(`  Private container: ${PRIVATE_CONTAINER}`);
  console.log("  Schema package: @bccweb/schemas (built dist; run `make build` if import fails)");
  console.log("");

  // ── Top-level index blobs ───────────────────────────────────────────────────
  console.log("── Top-level blobs ──");

  const config = await readBlob(privateClient, "config.json");
  assertObject("data-private/config.json", config, ["wingFactors", "maxScoringPilotsInTeam"]);
  assertScoringConfig("data-private/config.json", config);

  const userIndex = await readBlob(privateClient, "user-index.json", /* required= */ false);
  if (userIndex !== null) {
    assertObject("data-private/user-index.json", userIndex);
  } else {
    ok("data-private/user-index.json — not yet created (expected before first login)");
  }

  const pilots = await readBlob(publicClient, "pilots.json");
  const pilotsOk = assertArray("pilots.json", pilots);

  const clubs = await readBlob(publicClient, "clubs.json");
  const clubsOk = assertArray("clubs.json", clubs);

  const sites = await readBlob(publicClient, "sites.json");
  assertArray("sites.json", sites);

  const rounds = await readBlob(publicClient, "rounds.json");
  const roundsOk = assertArray("rounds.json", rounds);

  const seasons = await readBlob(publicClient, "seasons.json");
  const seasonsOk = assertArray("seasons.json", seasons);

  await readBlob(publicClient, "manufacturers.json");

  console.log("");

  console.log("── Public blob PII scan ──");
  for await (const blob of publicClient.listBlobsFlat()) {
    if (blob.name.endsWith(".json")) {
      await scanPublicBlobForPii(publicClient, blob.name);
    }
  }

  console.log("");

  // ── Per-entity spot-checks ──────────────────────────────────────────────────
  console.log("── Pilot spot-check (first 3) ──");
  if (pilotsOk && pilots.length > 0) {
    const sample = pilots.slice(0, 3);
    for (const pilot of sample) {
      const doc = await readBlob(privateClient, `pilots/${pilot.id}.json`);
      assertObject(`data-private/pilots/${pilot.id}.json`, doc, ["id", "person", "pilotRating"]);
    }
  }

  console.log("");
  console.log("── Club spot-check (first 3) ──");
  if (clubsOk && clubs.length > 0) {
    const sample = clubs.slice(0, 3);
    for (const club of sample) {
      const doc = await readBlob(privateClient, `clubs/${club.id}.json`);
      assertObject(`data-private/clubs/${club.id}.json`, doc, ["id", "name"]);
    }
  }

  console.log("");
  console.log("── Round spot-check (last 3 by date) ──");
  if (roundsOk && rounds.length > 0) {
    const sorted = [...rounds].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
    const sample = sorted.slice(0, 3);
    for (const round of sample) {
      const doc = await readBlob(privateClient, `rounds/${round.id}.json`);
      if (assertObject(`data-private/rounds/${round.id}.json`, doc, ["id", "date", "status", "teams"])) {
        if (!Array.isArray(doc.teams)) {
          fail(`data-private/rounds/${round.id}.json — teams is not an array`);
        } else {
          ok(`data-private/rounds/${round.id}.json — ${doc.teams.length} teams`);
          passed++; // extra check preserved from the legacy validator.
        }
      }
    }
  }

  console.log("");
  console.log("── Season spot-check ──");
  if (seasonsOk && seasons.length > 0) {
    for (const season of seasons) {
      const doc = await readBlob(publicClient, `seasons/${season.year}.json`);
      if (assertObject(`seasons/${season.year}.json`, doc, ["year", "leagueTable", "rounds"])) {
        if (!Array.isArray(doc.leagueTable)) {
          fail(`seasons/${season.year}.json — leagueTable is not an array`);
        } else if (doc.leagueTable.length === 0 && doc.rounds.length > 0) {
          fail(`seasons/${season.year}.json — leagueTable is empty but ${doc.rounds.length} rounds exist`);
        } else {
          ok(`seasons/${season.year}.json — leagueTable: ${doc.leagueTable.length} entries`);
          passed++;
        }

        const results = await readBlob(publicClient, `results/${season.year}.json`, /* required= */ false);
        if (results !== null) {
          if (Array.isArray(results)) {
            ok(`results/${season.year}.json — ${results.length} round results`);
            passed++;
          } else {
            fail(`results/${season.year}.json — expected array`);
          }
        } else {
          ok(`results/${season.year}.json — not yet created`);
        }
      }
    }
  }

  console.log("");
  console.log("── Legacy score preservation (manifest cross-check) ──");
  await crossCheckLegacyScores(privateClient, roundsOk ? rounds : []);

  console.log("");
  console.log("── Schema parse gate ──");
  const schemaStats = newSchemaStats();
  await runSchemaGate(PUBLIC_CONTAINER, publicClient, maps.public, schemaStats);
  await runSchemaGate(PRIVATE_CONTAINER, privateClient, maps.private, schemaStats);
  printSchemaSummary(schemaStats);

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log("");
  console.log("─────────────────────────────────────────");
  console.log(`  Passed: ${passed}`);
  if (failed > 0) {
    console.error(`  Failed: ${failed}`);
    console.error("  Migration validation FAILED — fix issues above before cutover.");
    process.exit(1);
  } else {
    console.log("  Migration validation PASSED — data looks correct.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Validator crashed:", err.message);
    console.error(err.stack);
    process.exit(1);
  });
}
