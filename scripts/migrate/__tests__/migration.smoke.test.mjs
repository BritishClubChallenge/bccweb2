// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * migration.smoke.test.mjs — End-to-end smoke test for scripts/migrate/migrate.mjs.
 *
 * Pipeline (Task 43):
 *   1. Verify Docker + Azurite are available — skip with a loud message otherwise.
 *   2. Spin up an ephemeral SQL Server (Azure SQL Edge on arm64; full MSSQL on amd64).
 *   3. Seed the canned fixture (scripts/migrate/fixtures/canned/{schema,seed}.sql).
 *   4. Run `migrate.mjs --dry-run` twice; assert byte-identical stdout (T8 idempotency).
 *   5. Run `migrate.mjs` for real; assert per-entity blob counts, canonical enums,
 *      and drift-healing guard cases.
 *   6. Run `validate.mjs`; assert schema gate exits 0 with zero rejects/strips.
 *   7. Run `reconcile.mjs`; assert zero anomalies.
 *   8. Run `privacy-scan.mjs --source <azurite>`; assert exit 0 (no PII in public blobs).
 *
 * Isolation:
 *   - CWD for migrate/reconcile is a per-test temp dir (so `.migration-state/` is local).
 *   - Azurite containers are per-test (`smoke-<run-id>` / `smoke-priv-<run-id>`); they are
 *     created and deleted by this test — never the dev `data` / `data-private` containers.
 *
 * Invocation:
 *   node --test scripts/migrate/__tests__/migration.smoke.test.mjs
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import sql from "mssql";
import { BlobServiceClient } from "@azure/storage-blob";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATE_DIR = resolve(__dirname, "..");
const REPO_ROOT = resolve(MIGRATE_DIR, "..", "..");
const FIXTURE_DIR = join(MIGRATE_DIR, "fixtures", "canned");
const MIGRATE_SCRIPT = join(MIGRATE_DIR, "migrate.mjs");
const VALIDATE_SCRIPT = join(MIGRATE_DIR, "validate.mjs");
const RECONCILE_SCRIPT = join(MIGRATE_DIR, "reconcile.mjs");
const PRIVACY_SCRIPT = join(REPO_ROOT, "scripts", "privacy-scan.mjs");
const SCHEMAS_DIST = resolve(REPO_ROOT, "packages", "schemas", "dist", "index.js");

const AZURITE_CS =
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;" +
  "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;" +
  "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";

// Hardcoded from packages/types/src/index.ts; do not import the workspace types/schemas packages here.
const COACH_TYPES = ["None", "ClubCoach", "SeniorCoach", "Instructor", "SeniorInstructor"];
const PILOT_RATINGS = ["Club Pilot", "Pilot", "Advanced Pilot"];
const WING_CLASSES = ["EN A", "EN B", "EN C", "EN C 2-liner", "EN D", "EN D 2-liner"];
const ROUND_STATUSES = ["Proposed", "Confirmed", "BriefComplete", "Locked", "Complete", "Cancelled"];
const PILOT_SLOT_STATUSES = ["Empty", "Filled"];
const SCORING_TYPES = ["XC", "Manual"];

// W6.1 — the Complete round's LEGACY scores exactly as seeded in
// fixtures/canned/seed.sql (RoundTeam.TeamScore / RoundTeamPilot.PilotPoints),
// keyed by teamName. Migration PRESERVES these verbatim. They are deliberately
// DISTINCT from RESCORED_PLACE1_POINTS (what the deleted raw-sum re-score would
// regenerate for these flights), so equality proves pass-through not regeneration.
const LEGACY_TEAM_ID = { "Test Club Alpha A": 501, "Test Club Bravo A": 502, "Test Club Charlie A": 503 };
const LEGACY_TEAM_SCORE = { "Test Club Alpha A": 842, "Test Club Bravo A": 1000, "Test Club Charlie A": 205 };
const LEGACY_PLACE1_POINTS = { "Test Club Alpha A": 842.5, "Test Club Bravo A": 1000, "Test Club Charlie A": 205 };
const RESCORED_PLACE1_POINTS = { "Test Club Alpha A": 38.3, "Test Club Bravo A": 35.6, "Test Club Charlie A": 18 };

// ─── Pre-flight availability checks ──────────────────────────────────────────

function checkDocker() {
  const r = spawnSync("docker", ["info"], { stdio: "ignore" });
  return r.status === 0;
}

async function checkAzurite() {
  try {
    const svc = BlobServiceClient.fromConnectionString(AZURITE_CS);
    // listContainers returns an async iterator; touching .next() forces a TCP roundtrip.
    const it = svc.listContainers();
    await it.next();
    return true;
  } catch {
    return false;
  }
}

function checkSchemasAvailable() {
  return existsSync(SCHEMAS_DIST);
}

const dockerOk = checkDocker();
const azuriteOk = await checkAzurite();
const schemasOk = checkSchemasAvailable();

if (!dockerOk) {
  console.log("[SKIP] migration.smoke: Docker not available; skipping smoke test.");
}
if (!azuriteOk) {
  console.log(
    "[SKIP] migration.smoke: Azurite not reachable at 127.0.0.1:10000; skipping smoke test.",
  );
}
if (!schemasOk) {
  console.log(
    "[SKIP:SCHEMA-GATE:LOUD] migration.smoke: the built schemas package (packages/schemas/dist) is unavailable; run `make build` from the worktree root before validating migrated blobs.",
  );
}

const SKIP = !dockerOk || !azuriteOk;
const SCHEMA_GATE_SKIP = SKIP || !schemasOk;

// ─── Per-run identifiers ─────────────────────────────────────────────────────

const RUN_ID = randomBytes(4).toString("hex");
const MSSQL_CONTAINER = `bcc-smoke-mssql-${RUN_ID}`;
const PUBLIC_CONTAINER = `smoke-public-${RUN_ID}`;
const PRIVATE_CONTAINER = `smoke-private-${RUN_ID}`;
const MSSQL_PASSWORD = "Smoke123!Strong";

let mssqlHost = null;
let mssqlPort = 1433;
let tmpDir = null;

// ─── Lifecycle ───────────────────────────────────────────────────────────────

before(async () => {
  if (SKIP) return;

  tmpDir = mkdtempSync(join(tmpdir(), "bcc-migrate-smoke-"));

  // Start SQL Server container (Azure SQL Edge: arm64 + amd64 compatible).
  execSync(
    [
      "docker run -d --rm",
      `--name ${MSSQL_CONTAINER}`,
      '-e "ACCEPT_EULA=1"',
      `-e "MSSQL_SA_PASSWORD=${MSSQL_PASSWORD}"`,
      "-p 0:1433",
      "mcr.microsoft.com/azure-sql-edge:latest",
    ].join(" "),
    { stdio: "ignore" },
  );

  // Resolve both possible connection routes. Docker Desktop exposes the random
  // published port on localhost; Apple's `container` runtime historically made
  // that unreliable, so keep the container-network IP route as a fallback.
  const inspect = JSON.parse(
    execSync(`docker inspect ${MSSQL_CONTAINER}`).toString(),
  );
  const networks = inspect[0]?.NetworkSettings?.Networks ?? {};
  const ip = Object.values(networks).find((n) => n?.IPAddress)?.IPAddress;
  const portOutput = execSync(`docker port ${MSSQL_CONTAINER} 1433`).toString().trim();
  const publishedPort = Number(portOutput.match(/:(\d+)$/)?.[1]);
  if (!ip) {
    throw new Error(
      "Could not determine MSSQL container IP from `docker inspect` output.",
    );
  }
  const candidates = [
    { host: ip, port: 1433, label: "container IP" },
    ...(Number.isInteger(publishedPort)
      ? [{ host: "127.0.0.1", port: publishedPort, label: "published localhost port" }]
      : []),
  ];

  // Poll until SQL Server accepts connections (Azure SQL Edge cold start
  // typically completes in 30–45s).
  const deadline = Date.now() + 120_000;
  let lastErr = null;
  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      try {
        const pool = await sql.connect({
          server: candidate.host,
          port: candidate.port,
          user: "sa",
          password: MSSQL_PASSWORD,
          database: "master",
          options: { encrypt: false, trustServerCertificate: true },
          connectionTimeout: 5_000,
        });
        await pool.request().query("SELECT 1 AS ok");
        await pool.close();
        mssqlHost = candidate.host;
        mssqlPort = candidate.port;
        lastErr = null;
        break;
      } catch (err) {
        lastErr = new Error(
          `${candidate.label} ${candidate.host}:${candidate.port} failed: ${err.message ?? err}`,
        );
      }
    }
    if (!lastErr) break;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  if (lastErr) {
    throw new Error(
      `MSSQL never became ready within 120s: ${lastErr.message ?? lastErr}`,
    );
  }

  // Create the smoke DB and load schema + seed.
  await execSqlBatch("master", "CREATE DATABASE bccweb_smoke");
  await execSqlFile("bccweb_smoke", join(FIXTURE_DIR, "schema.sql"));
  await execSqlFile("bccweb_smoke", join(FIXTURE_DIR, "seed.sql"));

  // Pre-create the Azurite containers we are going to write to so the
  // migration's first `upload` call doesn't 404. Public container is
  // configured with blob-level public access (matches prod `data`).
  const svc = BlobServiceClient.fromConnectionString(AZURITE_CS);
  await svc
    .getContainerClient(PUBLIC_CONTAINER)
    .createIfNotExists({ access: "blob" });
  await svc.getContainerClient(PRIVATE_CONTAINER).createIfNotExists();
});

after(async () => {
  // Best-effort teardown — always try to stop the container so a failed
  // test never leaves dangling SQL Server processes.
  if (MSSQL_CONTAINER) {
    try {
      execSync(`docker stop ${MSSQL_CONTAINER}`, { stdio: "ignore" });
    } catch {
      /* container already gone — fine */
    }
  }
  // Drop the per-run Azurite containers (best-effort).
  if (azuriteOk) {
    try {
      const svc = BlobServiceClient.fromConnectionString(AZURITE_CS);
      await svc.getContainerClient(PUBLIC_CONTAINER).deleteIfExists();
      await svc.getContainerClient(PRIVATE_CONTAINER).deleteIfExists();
    } catch {
      /* nothing to clean up */
    }
  }
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sqlConnectionString(database) {
  return (
    `Server=${mssqlHost},${mssqlPort};` +
    "User Id=sa;" +
    `Password=${MSSQL_PASSWORD};` +
    `Database=${database};` +
    "Encrypt=false;TrustServerCertificate=true;"
  );
}

async function execSqlBatch(database, batch) {
  const pool = await sql.connect({
    server: mssqlHost,
    port: mssqlPort,
    user: "sa",
    password: MSSQL_PASSWORD,
    database,
    options: { encrypt: false, trustServerCertificate: true },
  });
  try {
    await pool.request().batch(batch);
  } finally {
    await pool.close();
  }
}

async function execSqlFile(database, path) {
  const text = readFileSync(path, "utf8");
  // mssql's .batch() honours GO when splitting; the canned fixtures don't
  // use GO so a single batch call is fine.
  await execSqlBatch(database, text);
}

function runMigration({ dryRun }) {
  const env = {
    ...process.env,
    SQL_CONNECTION_STRING: sqlConnectionString("bccweb_smoke"),
    BLOB_CONNECTION_STRING: AZURITE_CS,
    BLOB_CONTAINER: PUBLIC_CONTAINER,
    BLOB_PRIVATE_CONTAINER: PRIVATE_CONTAINER,
  };
  if (dryRun) env.DRY_RUN = "1";
  const args = dryRun ? [MIGRATE_SCRIPT, "--dry-run"] : [MIGRATE_SCRIPT];
  const r = spawnSync("node", args, {
    cwd: tmpDir,
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return r;
}

function runValidate() {
  const r = spawnSync("node", [VALIDATE_SCRIPT], {
    cwd: tmpDir,
    env: {
      ...process.env,
      BLOB_CONNECTION_STRING: AZURITE_CS,
      BLOB_CONTAINER_NAME: PUBLIC_CONTAINER,
      BLOB_PRIVATE_CONTAINER_NAME: PRIVATE_CONTAINER,
    },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return r;
}

function runReconcile() {
  const r = spawnSync("node", [RECONCILE_SCRIPT], {
    cwd: tmpDir,
    env: process.env,
    encoding: "utf8",
  });
  return r;
}

function runPrivacyScan() {
  const r = spawnSync(
    "node",
    [PRIVACY_SCRIPT, "--source", AZURITE_CS],
    {
      cwd: tmpDir,
      env: { ...process.env, BLOB_CONTAINER_NAME: PUBLIC_CONTAINER },
      encoding: "utf8",
    },
  );
  return r;
}

async function listBlobPaths(containerName) {
  const svc = BlobServiceClient.fromConnectionString(AZURITE_CS);
  const c = svc.getContainerClient(containerName);
  const names = [];
  for await (const item of c.listBlobsFlat()) names.push(item.name);
  names.sort();
  return names;
}

async function readJsonBlob(containerName, path) {
  const svc = BlobServiceClient.fromConnectionString(AZURITE_CS);
  const c = svc.getContainerClient(containerName);
  const buf = await c.getBlobClient(path).downloadToBuffer();
  return JSON.parse(buf.toString("utf8"));
}

async function writeJsonBlob(containerName, path, obj) {
  const svc = BlobServiceClient.fromConnectionString(AZURITE_CS);
  const c = svc.getContainerClient(containerName);
  const json = JSON.stringify(obj, null, 2);
  await c.getBlockBlobClient(path).upload(json, Buffer.byteLength(json), {
    blobHTTPHeaders: { blobContentType: "application/json" },
  });
}

function assertCanonical(value, allowed, label) {
  assert.ok(
    allowed.includes(value),
    `${label} must be one of ${allowed.join(", ")} (got ${JSON.stringify(value)})`,
  );
}

function assertNoKeysWithPrefix(value, prefix, label) {
  for (const key of Object.keys(value)) {
    assert.ok(!key.startsWith(prefix), `${label} must not include ${prefix}* key ${key}`);
  }
}

// stdout from migrate includes timestamps in `--dry-run` form only for blob
// byte sizes (deterministic from fixture). Strip generated UUIDs and run-time
// noise that legitimately varies (we keep the byte counts and structure).
function normaliseMigrationStdout(s) {
  return s
    // UUIDs (8-4-4-4-12 hex) — generated UUIDs are stable across runs thanks
    // to T8 (id-map persisted in CWD/.migration-state). Leave them in place
    // for the comparison so a regression that breaks T8 also breaks this test.
    .replace(/\r\n/g, "\n");
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test("migration smoke: dry-run idempotency (T8 byte-identical)", { skip: SKIP }, async () => {
  const first = runMigration({ dryRun: true });
  assert.equal(first.status, 0, `first dry-run failed:\n${first.stderr}\n${first.stdout}`);

  const second = runMigration({ dryRun: true });
  assert.equal(second.status, 0, `second dry-run failed:\n${second.stderr}\n${second.stdout}`);

  const a = normaliseMigrationStdout(first.stdout);
  const b = normaliseMigrationStdout(second.stdout);
  assert.equal(
    Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")),
    0,
    `dry-run stdout differed between runs:\n--- first ---\n${a}\n--- second ---\n${b}`,
  );
  assert.equal(a, b, "dry-run stdout is byte-identical after CRLF normalisation");
});

test("migration smoke: real run writes expected blobs", { skip: SKIP }, async () => {
  const r = runMigration({ dryRun: false });
  assert.equal(
    r.status,
    0,
    `migration exited ${r.status}:\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`,
  );
  assert.match(r.stdout, /Migration complete\./);

  // ── Public blob assertions ────────────────────────────────────────────
  const publicBlobs = await listBlobPaths(PUBLIC_CONTAINER);

  // Fixture has 3 clubs → public clubs.json length === 3.
  const clubsIndex = await readJsonBlob(PUBLIC_CONTAINER, "clubs.json");
  assert.ok(Array.isArray(clubsIndex), "clubs.json should be an array");
  assert.equal(clubsIndex.length, 3, "clubs.json length");
  assert.ok(
    clubsIndex.every((c) => typeof c.id === "string" && typeof c.name === "string"),
    "every clubs.json entry has id + name",
  );
  // PII guard: the public clubs index has no PII-bearing fields.
  for (const c of clubsIndex) {
    assert.equal(c.email, undefined);
    assert.equal(c.phoneNumber, undefined);
  }

  const pilotsIndex = await readJsonBlob(PUBLIC_CONTAINER, "pilots.json");
  assert.equal(pilotsIndex.length, 3, "pilots.json length");
  for (const p of pilotsIndex) {
    assert.equal(p.email, undefined, "public pilots index must not carry email");
    assert.equal(p.phoneNumber, undefined, "public pilots index must not carry phone");
    assert.equal(p.medicalInfo, undefined);
  }

  const sitesIndex = await readJsonBlob(PUBLIC_CONTAINER, "sites.json");
  assert.equal(sitesIndex.length, 3, "sites.json length");

  const seasonsIndex = await readJsonBlob(PUBLIC_CONTAINER, "seasons.json");
  assert.equal(seasonsIndex.length, 2, "seasons.json length");

  const roundsIndex = await readJsonBlob(PUBLIC_CONTAINER, "rounds.json");
  assert.equal(roundsIndex.length, 3, "rounds.json length");
  for (const round of roundsIndex) {
    assertCanonical(round.status, ROUND_STATUSES, `rounds.json legacyId=${round.legacyId} status`);
  }
  const completeRound = roundsIndex.find((r) => r.status === "Complete");
  assert.ok(completeRound, "exactly one round should have status Complete");
  assert.equal(completeRound.siteName, "Test Site Bravo");
  const sitelessRound = roundsIndex.find((round) => round.legacyId === 403);
  assert.ok(sitelessRound, "Deleted/siteless legacy round 403 is retained in rounds.json");
  assert.equal(sitelessRound.siteId, null, "siteless legacy round has null summary siteId");
  assert.equal(sitelessRound.siteName, "", "siteless legacy round keeps empty summary siteName");

  // Public season-clubs index for 2026 should have one entry per club.
  const seasonClubIndex2026 = await readJsonBlob(
    PUBLIC_CONTAINER,
    "season-clubs/2026/index.json",
  );
  assert.equal(seasonClubIndex2026.length, 3, "2026 season-club index length");

  // Public results for 2026 should reflect the single Complete round.
  const results2026 = await readJsonBlob(PUBLIC_CONTAINER, "results/2026.json");
  assert.equal(results2026.length, 1, "one Complete round → one entry in results/2026.json");
  assert.equal(results2026[0].teamResults.length, 3, "three teams in the Complete round");
  const resultPilots = results2026[0].teamResults.flatMap((tr) => tr.pilots);
  assert.ok(resultPilots.length >= 3, "produced results carry a pilot row per team's flighted place-1 pilot");
  for (const p of resultPilots) {
    assert.ok(
      p.pilotId === null || typeof p.pilotId === "string",
      `results pilot row pilotId is string|null, never undefined (got ${JSON.stringify(p.pilotId)})`,
    );
  }
  assert.ok(
    resultPilots.some((p) => typeof p.pilotId === "string"),
    "migrated results carry a UUID string pilotId (ported buildSeasonResults emits pilotId in lockstep with recompute.ts)",
  );

  // ── Private blob assertions ───────────────────────────────────────────
  const privateBlobs = await listBlobPaths(PRIVATE_CONTAINER);

  // Per-entity counts under the private container.
  const countPrefix = (prefix) =>
    privateBlobs.filter((p) => p.startsWith(prefix)).length;

  assert.equal(countPrefix("clubs/"), 3, "private clubs/{uuid}.json count");
  assert.equal(countPrefix("sites/"), 3, "private sites/{uuid}.json count");
  // pilots/ includes pilots/{uuid}.json (3) AND pilots/{uuid}/club-history.json (3).
  const pilotsPrivate = privateBlobs.filter((p) => p.startsWith("pilots/"));
  const pilotDocs = pilotsPrivate.filter((p) => /^pilots\/[^/]+\.json$/.test(p));
  const pilotHistoryDocs = pilotsPrivate.filter((p) =>
    /^pilots\/[^/]+\/club-history\.json$/.test(p),
  );
  assert.equal(pilotDocs.length, 3, "pilots/{uuid}.json count");
  assert.equal(pilotHistoryDocs.length, 3, "pilot club-history blob count");
  assert.equal(countPrefix("rounds/"), 3, "private rounds/{uuid}.json count");
  assert.equal(countPrefix("manufacturers/"), 0, "manufacturers/{uuid}.json blobs are no longer written");
  assert.ok(publicBlobs.includes("manufacturers.json"), "manufacturers.json lookup list is written to the public container");
  assert.ok(!privateBlobs.includes("pilot-ratings.json"), "pilot-ratings.json blob is no longer written");
  assert.ok(!privateBlobs.includes("frequencies.json"), "frequencies.json blob is no longer written");
  // season-clubs/{year}/{clubId}.json are private (detail), one per row → 3.
  // The yearly index lives in the PUBLIC container, not here.
  assert.equal(countPrefix("season-clubs/"), 3, "private season-clubs detail count");
  assert.equal(countPrefix("round-briefs/"), 1, "round-briefs count");
  // Three RoundTeamPilots in the Complete round all had SignToFly=true except
  // pilot 203 → expect 2 legacy-migrated signature blobs.
  assert.equal(countPrefix("signatures/"), 2, "legacy-migrated signatures (T18) count");

  // Pilot blobs: expected shape + canonical enum membership.
  const pilotDocsByLegacyId = new Map();
  for (const path of pilotDocs) {
    const doc = await readJsonBlob(PRIVATE_CONTAINER, path);
    pilotDocsByLegacyId.set(doc.legacyId, doc);
    assert.equal(typeof doc.id, "string");
    assert.equal(typeof doc.legacyId, "number");
    assert.ok(doc.person, "pilot doc carries embedded person");
    assert.equal(typeof doc.person.firstName, "string");
    assert.equal(typeof doc.person.lastName, "string");
    assert.notEqual(doc.person.firstName.trim(), "", `pilot ${doc.legacyId} firstName is readable/non-empty`);
    assert.notEqual(doc.person.lastName.trim(), "", `pilot ${doc.legacyId} lastName is readable/non-empty`);
    assertCanonical(doc.coachType, COACH_TYPES, `pilot ${doc.legacyId} coachType`);
    assertCanonical(doc.pilotRating, PILOT_RATINGS, `pilot ${doc.legacyId} pilotRating`);
    if (doc.wingClass !== undefined) {
      assertCanonical(doc.wingClass, WING_CLASSES, `pilot ${doc.legacyId} wingClass`);
    }
  }
  const blankNamePilot = pilotDocsByLegacyId.get(203);
  assert.ok(blankNamePilot, "blank-name legacy pilot 203 is readable");
  assert.equal(blankNamePilot.person.firstName, "Synthetic Charlie", "blank first name falls back to fullName");
  assert.equal(blankNamePilot.person.lastName, "Charlie", "blank-name pilot keeps last name");

  const sitelessRoundDoc = await readJsonBlob(
    PRIVATE_CONTAINER,
    `rounds/${sitelessRound.id}.json`,
  );
  assert.equal(sitelessRoundDoc.site.id, "legacy-no-site", "siteless private round uses sentinel site id");
  assert.equal(sitelessRoundDoc.site.name, "Unknown site", "siteless private round uses readable sentinel site name");

  // Spot-check: the Complete round's blob has 3 teams, each with pilots[]
  // and the place-1 pilot carries a non-null pilotId.
  const completeRoundDoc = await readJsonBlob(
    PRIVATE_CONTAINER,
    `rounds/${completeRound.id}.json`,
  );
  assert.equal(completeRoundDoc.teams.length, 3, "complete round has 3 teams");
  const clublessTeam = completeRoundDoc.teams.find((team) => team.teamName === "Test Club Charlie A");
  assert.ok(clublessTeam, "clubless/nameless legacy team is retained in Complete round");
  assert.equal(clublessTeam.club.id, "legacy-no-club", "clubless team uses sentinel club id");
  assert.equal(clublessTeam.club.name, "Unknown club", "clubless team uses readable sentinel club name");
  for (const team of completeRoundDoc.teams) {
    const place1 = team.pilots.find((p) => p.placeInTeam === 1);
    assert.ok(place1, "every team has a place-1 pilot slot");
    assert.equal(typeof place1.pilotId, "string", "place-1 pilotId is a UUID string");
    assertCanonical(place1.status, PILOT_SLOT_STATUSES, `team ${team.teamName} place-1 status`);
    assertCanonical(place1.snapshot.wingClass, WING_CLASSES, `team ${team.teamName} place-1 wingClass`);
    assertCanonical(place1.snapshot.pilotRating, PILOT_RATINGS, `team ${team.teamName} place-1 pilotRating`);
    assert.ok(place1.flight, "place-1 slot has a flight");
    assert.ok(place1.flight.distance > 0, "flight has non-zero distance");
    assertCanonical(place1.flight.scoringType, SCORING_TYPES, `team ${team.teamName} place-1 scoringType`);

    // W6.1 — team carries the legacy RoundTeam.ID (the manifest match key).
    assert.equal(typeof team.legacyId, "number", `team ${team.teamName} carries legacy RoundTeam.ID`);
    assert.equal(team.legacyId, LEGACY_TEAM_ID[team.teamName], `team ${team.teamName} legacyId`);

    // W6.1 — legacy scores are PRESERVED VERBATIM: migrated team.score and place-1
    // pilotPoints EQUAL the canned legacy values and are NOT the values the deleted
    // raw-sum re-score would regenerate (proves pass-through, not recomputation).
    assert.equal(team.score, LEGACY_TEAM_SCORE[team.teamName], `team ${team.teamName} score preserved == legacy TeamScore`);
    assert.equal(place1.pilotPoints, LEGACY_PLACE1_POINTS[team.teamName], `team ${team.teamName} place-1 pilotPoints preserved == legacy PilotPoints`);
    assert.notEqual(place1.pilotPoints, RESCORED_PLACE1_POINTS[team.teamName], `team ${team.teamName} place-1 pilotPoints is NOT the re-scored value`);
  }
  // Legacy TeamScores were preserved (all seeded > 0), never recomputed.
  assert.ok(
    completeRoundDoc.teams.every((t) => t.score > 0),
    "every team keeps its preserved legacy TeamScore (all seeded > 0)",
  );

  const briefDoc = await readJsonBlob(PRIVATE_CONTAINER, `round-briefs/${completeRound.id}.json`);
  assert.equal(briefDoc.roundId, completeRound.id, "dateless legacy brief for Complete round is readable");
  assert.equal(briefDoc.legacyId, undefined, "round brief omits unmodelled legacyId so schema gate cannot strip it");
  assert.equal(briefDoc.date, completeRoundDoc.date, "dateless brief falls back to round date");
  assert.equal(briefDoc.frequencyMhz, 145.525, "Complete round brief carries organising-club frequencyMhz");
  assertCanonical(briefDoc.briefer.bhpaCoachLevel, COACH_TYPES, "brief briefer.bhpaCoachLevel");
  for (const team of briefDoc.teams) {
    for (const pilot of team.pilots) {
      assertCanonical(pilot.snapshot.wingClass, WING_CLASSES, `brief ${team.teamName} pilot wingClass`);
      assertCanonical(pilot.snapshot.pilotRating, PILOT_RATINGS, `brief ${team.teamName} pilot pilotRating`);
    }
  }

  for (const signaturePath of privateBlobs.filter((path) => path.startsWith("signatures/"))) {
    const signature = await readJsonBlob(PRIVATE_CONTAINER, signaturePath);
    assert.equal(signature.userId, "legacy-import", `${signaturePath} legacy signature userId`);
    assert.equal(signature.source, "legacy-migrated", `${signaturePath} legacy signature source`);
    assert.equal(typeof signature.pilotId, "string", `${signaturePath} legacy signature pilotId`);
  }

  const seasonClubDetailPaths = privateBlobs.filter((path) => /^season-clubs\/[^/]+\/[^/]+\.json$/.test(path));
  assert.equal(seasonClubDetailPaths.length, 3, "season-club detail blob count");
  const seasonClubDetails = [];
  for (const path of seasonClubDetailPaths) {
    const detail = await readJsonBlob(PRIVATE_CONTAINER, path);
    seasonClubDetails.push(detail);
    assertNoKeysWithPrefix(detail, "frequency", `${path} detail`);
    assert.equal(detail.acceptedTsCsAt, undefined, `${path} has no acceptedTsCsAt`);
    assert.equal(detail.acceptedTsCsBy, undefined, `${path} has no acceptedTsCsBy`);
  }
  const acceptTsCsFalseClub = seasonClubDetails.find((detail) => detail.legacyId === 3);
  assert.ok(acceptTsCsFalseClub, "AcceptTsCs=0 season club detail is readable");
  assert.equal(acceptTsCsFalseClub.acceptedTsCs, false, "AcceptTsCs=0 maps to acceptedTsCs:false");

  // ── Sanity: required public blob names are present ────────────────────
  for (const required of [
    "clubs.json",
    "pilots.json",
    "sites.json",
    "seasons.json",
    "rounds.json",
    "seasons/2026.json",
    "results/2026.json",
  ]) {
    assert.ok(
      publicBlobs.includes(required),
      `expected public blob ${required} (got: ${publicBlobs.slice(0, 12).join(", ")}…)`,
    );
  }
});

test("migration smoke: legacy-score manifest emitted with nested legacy-id keying", { skip: SKIP }, async () => {
  const manifestPath = join(tmpDir, ".migration-state", "legacy-score-manifest.json");
  assert.ok(existsSync(manifestPath), `legacy-score manifest missing at ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  // Nested keying: legacy round id → legacy round-team id → { teamScore, pilots:{ place: points } }.
  assert.deepEqual(Object.keys(manifest).sort(), ["402"], "manifest holds exactly the one Complete round (legacy id 402)");
  const round402 = manifest["402"];
  assert.deepEqual(Object.keys(round402).sort(), ["501", "502", "503"], "manifest keys teams by legacy RoundTeam.ID");

  assert.equal(round402["501"].teamScore, 842, "manifest teamScore == legacy (Alpha 501)");
  assert.deepEqual(round402["501"].pilots, { "1": 842.5 }, "manifest pilots keyed by placeInTeam == legacy PilotPoints (Alpha 501)");
  assert.equal(round402["502"].teamScore, 1000, "manifest teamScore == legacy (Bravo 502)");
  assert.deepEqual(round402["502"].pilots, { "1": 1000 }, "manifest pilots == legacy (Bravo 502)");
  assert.equal(round402["503"].teamScore, 205, "manifest teamScore == legacy (Charlie 503)");
  assert.deepEqual(round402["503"].pilots, { "1": 205 }, "manifest pilots == legacy (Charlie 503)");
});

test("migration smoke: schema gate validates migrated blobs", { skip: SCHEMA_GATE_SKIP }, async () => {
  const r = runValidate();
  assert.equal(
    r.status,
    0,
    `validate exited ${r.status}:\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`,
  );
  assert.match(r.stdout, /── Schema parse gate summary ──/);
  assert.match(r.stdout, /Rejects: 0/, "schema gate rejects must be zero");
  assert.match(r.stdout, /Strips: 0/, "schema gate strips must be zero");
  assert.doesNotMatch(r.stdout, /UNEXPECTED/, "schema gate must not report unexpected heals");
  const healLines = r.stdout
    .split("\n")
    .filter((line) => line.includes("CHANGE "));
  assert.ok(healLines.length > 0, "schema gate should report the siteless-round allowlisted heal");
  for (const line of healLines) {
    assert.match(
      line,
      /CHANGE (sites\.clubId|rounds\.siteId) — \d+ heal\(s\), allowlisted/,
      `schema gate heal must be allowlisted: ${line}`,
    );
  }
  assert.match(r.stdout, /CHANGE rounds\.siteId — \d+ heal\(s\), allowlisted/);
  // W6.1 — the new validate sections PASS on the clean migrated output.
  assert.match(r.stdout, /scoring config keys present \+ valid/, "config-keys check passes on migrated config");
  assert.match(r.stdout, /Legacy score preservation \(manifest cross-check\)/, "manifest cross-check section runs");
  assert.match(r.stdout, /team\.score preserved/, "migrated team.score matches the legacy manifest");
  assert.match(r.stdout, /pilotPoints preserved/, "migrated pilotPoints matches the legacy manifest");
  assert.match(r.stdout, /Migration validation PASSED — data looks correct\./);
  console.log(`\n[validate.mjs stdout]\n${r.stdout.trim()}\n[/validate.mjs stdout]`);
});

test("migration smoke: validate SKIPS legacy-score preservation when local manifest is absent", { skip: SCHEMA_GATE_SKIP }, () => {
  const manifestPath = join(tmpDir, ".migration-state", "legacy-score-manifest.json");
  const originalManifest = readFileSync(manifestPath, "utf8");

  try {
    rmSync(manifestPath);
    const withoutManifest = runValidate();
    assert.equal(
      withoutManifest.status,
      0,
      `validate must not fail when local migration state is absent:\nSTDOUT:\n${withoutManifest.stdout}\nSTDERR:\n${withoutManifest.stderr}`,
    );
    assert.match(withoutManifest.stdout, /⊘  legacy-score manifest not present — skipping legacy-score preservation check/);
    assert.match(withoutManifest.stdout, /Skipped: 1/);
    assert.match(withoutManifest.stdout, /Migration validation PASSED with SKIPS/);
  } finally {
    writeFileSync(manifestPath, originalManifest, "utf8");
  }
});

test("migration smoke: validate FAILS on perturbed manifest value and on missing legacyId", { skip: SCHEMA_GATE_SKIP }, async () => {
  const manifestPath = join(tmpDir, ".migration-state", "legacy-score-manifest.json");
  const originalManifest = readFileSync(manifestPath, "utf8");

  // (a) Perturb a manifest teamScore → the migrated blob no longer matches → FAIL.
  const perturbed = JSON.parse(originalManifest);
  perturbed["402"]["501"].teamScore += 999;
  writeFileSync(manifestPath, `${JSON.stringify(perturbed, null, 2)}\n`, "utf8");
  const afterPerturb = runValidate();
  assert.notEqual(
    afterPerturb.status,
    0,
    `validate must FAIL when a manifest score is perturbed:\nSTDOUT:\n${afterPerturb.stdout}\nSTDERR:\n${afterPerturb.stderr}`,
  );
  assert.match(`${afterPerturb.stdout}${afterPerturb.stderr}`, /not preserved/, "failure names the legacy-score mismatch");

  // Restore the manifest → validate PASSES again (confirms the perturbation was the cause).
  writeFileSync(manifestPath, originalManifest, "utf8");
  const afterManifestRestore = runValidate();
  assert.equal(
    afterManifestRestore.status,
    0,
    `validate must PASS again after restoring the manifest:\nSTDOUT:\n${afterManifestRestore.stdout}\nSTDERR:\n${afterManifestRestore.stderr}`,
  );

  // (b) Drop a team.legacyId match key from a Complete round blob → HARD FAIL (never a silent skip).
  const roundsIndex = await readJsonBlob(PUBLIC_CONTAINER, "rounds.json");
  const complete = roundsIndex.find((round) => round.status === "Complete");
  const roundDoc = await readJsonBlob(PRIVATE_CONTAINER, `rounds/${complete.id}.json`);
  const mutated = structuredClone(roundDoc);
  delete mutated.teams[0].legacyId;
  await writeJsonBlob(PRIVATE_CONTAINER, `rounds/${complete.id}.json`, mutated);
  const afterMissing = runValidate();
  assert.notEqual(
    afterMissing.status,
    0,
    `validate must FAIL when a team.legacyId match key is missing:\nSTDOUT:\n${afterMissing.stdout}\nSTDERR:\n${afterMissing.stderr}`,
  );
  assert.match(`${afterMissing.stdout}${afterMissing.stderr}`, /legacyId/, "failure names the missing legacyId match key");

  // Restore the round blob → validate PASSES again.
  await writeJsonBlob(PRIVATE_CONTAINER, `rounds/${complete.id}.json`, roundDoc);
  const afterBlobRestore = runValidate();
  assert.equal(
    afterBlobRestore.status,
    0,
    `validate must PASS again after restoring the round blob:\nSTDOUT:\n${afterBlobRestore.stdout}\nSTDERR:\n${afterBlobRestore.stderr}`,
  );
});

test("migration smoke: reconcile reports zero anomalies", { skip: SKIP }, async () => {
  const r = runReconcile();
  assert.equal(
    r.status,
    0,
    `reconcile exited ${r.status}:\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`,
  );
  assert.match(r.stdout, /No anomalies detected\./);

  // Inspect the persisted report directly.
  const reportPath = join(tmpDir, ".migration-state", "reconciliation-report.json");
  assert.ok(existsSync(reportPath), `report missing at ${reportPath}`);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(report.anomalies.length, 0, "no anomalies");
  // T32 audit trail: 2 RoundClubPilots in fixture must surface in discarded.
  assert.equal(report.discarded.roundClubPilot, 2);
});

test("migration smoke: privacy-scan passes on public blobs (T22)", { skip: SKIP }, async () => {
  const r = runPrivacyScan();
  assert.equal(
    r.status,
    0,
    `privacy-scan exited ${r.status} (expected 0):\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`,
  );
  assert.match(
    r.stdout,
    /\[PASS\] public-blob-scan/,
    "privacy-scan should report PASS on public blobs",
  );
});

// MUST STAY LAST: this test PERTURBS the source DB and re-migrates, leaving the
// Azurite blobs + manifest in a perturbed state. No later test may depend on the
// baseline seed values.
test("migration smoke: perturbing a canned legacy score flows through to the migrated blob (no recompute)", { skip: SKIP }, async () => {
  // §3(a) dynamic pass-through proof. Perturb the CANNED legacy scores in the
  // source DB to sentinel values that NO recompute of these flights could ever
  // produce (distance×wingFactor≈38.3), then re-migrate. If migration re-scored,
  // the blob would show the regenerated ~38.3; pass-through means it shows the
  // perturbed legacy value verbatim — proving migration reads, never recomputes.
  await execSqlBatch(
    "bccweb_smoke",
    "UPDATE RoundTeamPilots SET PilotPoints = 777.5 WHERE ID = 601;\n" +
      "UPDATE RoundTeams SET TeamScore = 888 WHERE ID = 501;",
  );
  const migrated = runMigration({ dryRun: false });
  assert.equal(
    migrated.status,
    0,
    `re-migration after perturbation failed:\nSTDOUT:\n${migrated.stdout}\nSTDERR:\n${migrated.stderr}`,
  );

  const roundsIndex = await readJsonBlob(PUBLIC_CONTAINER, "rounds.json");
  const complete = roundsIndex.find((round) => round.status === "Complete");
  const doc = await readJsonBlob(PRIVATE_CONTAINER, `rounds/${complete.id}.json`);
  const alpha = doc.teams.find((t) => t.teamName === "Test Club Alpha A");
  const place1 = alpha.pilots.find((p) => p.placeInTeam === 1);

  assert.equal(alpha.score, 888, "perturbed legacy TeamScore flows through verbatim (blob is not recomputed)");
  assert.equal(place1.pilotPoints, 777.5, "perturbed legacy PilotPoints flows through verbatim (blob is not recomputed)");
  assert.notEqual(
    place1.pilotPoints,
    RESCORED_PLACE1_POINTS["Test Club Alpha A"],
    "perturbed value is not the value a re-score would regenerate",
  );

  // The manifest is sourced from the same legacy rows, so it reflects the
  // perturbation too — keeping migrated == manifest == legacy.
  const manifest = JSON.parse(
    readFileSync(join(tmpDir, ".migration-state", "legacy-score-manifest.json"), "utf8"),
  );
  assert.equal(manifest["402"]["501"].teamScore, 888, "manifest reflects the perturbed teamScore");
  assert.deepEqual(manifest["402"]["501"].pilots, { "1": 777.5 }, "manifest reflects the perturbed pilotPoints");

  // manifest == blob, so validate still PASSES on the perturbed-but-consistent output.
  if (!schemasOk) return;
  const v = runValidate();
  assert.equal(
    v.status,
    0,
    `validate must PASS after a legacy-score perturbation (manifest == blob):\nSTDOUT:\n${v.stdout}\nSTDERR:\n${v.stderr}`,
  );
  assert.match(v.stdout, /Migration validation PASSED/);
});
