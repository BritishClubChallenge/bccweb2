#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * reconcile.mjs
 *
 * Reads .migration-state/id-map.json and emits a reconciliation report.
 * Useful for auditing migration completeness and detecting anomalies.
 *
 * Usage:
 *   node scripts/migrate/reconcile.mjs
 *   node scripts/migrate/reconcile.mjs --against-prod-snapshot <path>
 *
 * Output:
 *   .migration-state/reconciliation-report.json
 *   .migration-state/prod-dryrun-report.json when --against-prod-snapshot is used
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readDiscardedCounts } from "./discarded-counts.mjs";
import { readNormalizationCounts } from "./normalization-counts.mjs";
import { blobServiceUrl } from "./blobClient.mjs";

const STATE_DIR = ".migration-state";
const MAP_PATH = join(STATE_DIR, "id-map.json");
const STDOUT_PATH = join(STATE_DIR, "prod-dryrun-stdout.txt");
const DEFAULT_REPORT_PATH = join(STATE_DIR, "reconciliation-report.json");
const PROD_REPORT_PATH = join(STATE_DIR, "prod-dryrun-report.json");

const argv = process.argv.slice(2);

function getArg(flag) {
  const idx = argv.indexOf(flag);
  return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
}

const prodSnapshotPath = getArg("--against-prod-snapshot");
const outputPath = prodSnapshotPath ? PROD_REPORT_PATH : DEFAULT_REPORT_PATH;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readJsonFile(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(`Failed to parse ${label} at ${path}: ${err.message}`);
  }
}

function maskConnectionString(value) {
  if (!value) return null;
  return value
    .replace(/Password=[^;]+/gi, "Password=***")
    .replace(/AccountKey=[^;]+/gi, "AccountKey=***")
    .replace(/SharedAccessSignature=[^?&"'\s]+/gi, "SharedAccessSignature=***")
    .replace(/Authorization:\s*\S+/gi, "Authorization:***");
}

if (!existsSync(MAP_PATH)) {
  fail(`No id-map found at ${MAP_PATH}. Run migrate.mjs first.`);
}

const idMap = readJsonFile(MAP_PATH, "id-map");

function groupIdMapByEntity(map) {
  const byEntity = /** @type {Record<string, string[]>} */ ({});
  for (const [key, uuid] of Object.entries(map)) {
    const colonIdx = key.indexOf(":");
    const entity = colonIdx !== -1 ? key.slice(0, colonIdx) : "unknown";
    if (!byEntity[entity]) byEntity[entity] = [];
    byEntity[entity].push(uuid);
  }
  return byEntity;
}

function buildPerEntity(byEntity) {
  /** @type {Record<string, { count: number, sample: string[] }>} */
  const perEntity = {};
  for (const [entity, uuids] of Object.entries(byEntity).sort(([a], [b]) => a.localeCompare(b))) {
    perEntity[entity] = {
      count: uuids.length,
      sample: uuids.slice(0, 3),
    };
  }
  return perEntity;
}

function baseAnomalies(map) {
  const anomalies = [];
  const allUuids = Object.values(map);
  const uuidSet = new Set(allUuids);
  if (uuidSet.size !== allUuids.length) {
    const dupeCount = allUuids.length - uuidSet.size;
    anomalies.push({
      type: "duplicate_uuid",
      message: `${dupeCount} duplicate UUID value(s) detected across different entity keys`,
    });
  }

  const malformed = Object.keys(map).filter((k) => !k.includes(":"));
  if (malformed.length > 0) {
    anomalies.push({
      type: "malformed_key",
      message: `${malformed.length} key(s) missing entity prefix: ${malformed.slice(0, 3).join(", ")}`,
    });
  }
  return anomalies;
}

function readProdDryRunStdout() {
  if (!existsSync(STDOUT_PATH)) return null;
  return readFileSync(STDOUT_PATH, "utf8");
}

function parseExpectedCounts(snapshot) {
  const expected = snapshot?.expectedCounts ?? snapshot?.expected ?? snapshot?.counts ?? snapshot?.perEntity;
  if (!expected || typeof expected !== "object") return {};

  return Object.fromEntries(
    Object.entries(expected)
      .map(([entity, value]) => {
        if (typeof value === "number") return [entity, value];
        if (value && typeof value === "object" && typeof value.count === "number") return [entity, value.count];
        if (value && typeof value === "object" && typeof value.expectedCount === "number") {
          return [entity, value.expectedCount];
        }
        return null;
      })
      .filter(Boolean),
  );
}

function expectedCountsFromStdout(stdout) {
  if (!stdout) return {};
  const patterns = [
    ["manufacturer", /wrote\s+(\d+)\s+manufacturers\b/i],
    ["rating", /wrote\s+(\d+)\s+pilot ratings\b/i],
    ["club", /wrote\s+(\d+)\s+clubs\b/i],
    ["site", /wrote\s+(\d+)\s+sites\b/i],
    ["season", /wrote\s+(\d+)\s+seasons\b/i],
    ["pilot", /wrote\s+(\d+)\s+pilots\b/i],
    ["round", /wrote\s+(\d+)\s+rounds\b/i],
    ["frequency", /wrote\s+(\d+)\s+frequencies\b/i],
  ];

  const counts = {};
  for (const [entity, pattern] of patterns) {
    const match = stdout.match(pattern);
    if (match) counts[entity] = Number(match[1]);
  }
  return counts;
}

function buildProdRows(perEntity, snapshotExpected, stdoutExpected) {
  const entityNames = new Set([
    ...Object.keys(perEntity),
    ...Object.keys(snapshotExpected),
    ...Object.keys(stdoutExpected),
  ]);
  const rows = {};
  for (const entity of [...entityNames].sort()) {
    const expectedCount = snapshotExpected[entity] ?? stdoutExpected[entity] ?? perEntity[entity]?.count ?? 0;
    const actualCount = perEntity[entity]?.count ?? 0;
    const anomalies = [];
    if (actualCount !== expectedCount) {
      anomalies.push({
        type: "count_mismatch",
        message: `${entity}: expected ${expectedCount}, got ${actualCount}`,
      });
    }
    rows[entity] = {
      entity,
      expectedCount,
      actualCount,
      idMapStable: true,
      anomalies,
    };
  }
  return rows;
}

const byEntity = groupIdMapByEntity(idMap);
const perEntity = buildPerEntity(byEntity);
const anomalies = baseAnomalies(idMap);
const allUuids = Object.values(idMap);
const discarded = readDiscardedCounts(STATE_DIR) ?? {};
const normalizationCounts = readNormalizationCounts(STATE_DIR) ?? {};

let source;
let prodRows;
let stdoutExpectedCounts = {};
if (prodSnapshotPath) {
  if (!existsSync(prodSnapshotPath)) fail(`No production snapshot found at ${prodSnapshotPath}`);
  const snapshot = readJsonFile(prodSnapshotPath, "production snapshot");
  const stdout = readProdDryRunStdout();
  stdoutExpectedCounts = expectedCountsFromStdout(stdout);
  const snapshotExpectedCounts = parseExpectedCounts(snapshot);
  prodRows = buildProdRows(perEntity, snapshotExpectedCounts, stdoutExpectedCounts);

  for (const row of Object.values(prodRows)) {
    anomalies.push(...row.anomalies.map((a) => ({ ...a, entity: row.entity })));
  }

  source = {
    sqlConn: maskConnectionString(process.env.PROD_SQL_CONN ?? process.env.SQL_CONNECTION_STRING),
    blobConn: maskConnectionString(process.env.PROD_BLOB_CONN ?? process.env.BLOB_CONNECTION_STRING) ??
      (process.env.BLOB_STORAGE_ACCOUNT_NAME
        ? blobServiceUrl(process.env.BLOB_STORAGE_ACCOUNT_NAME)
        : null),
    prodSnapshot: prodSnapshotPath,
    dryRunStdout: existsSync(STDOUT_PATH) ? STDOUT_PATH : null,
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  ...(source ? { source } : {}),
  totalEntries: allUuids.length,
  perEntity,
  ...(prodRows ? { prodRows, stdoutExpectedCounts } : {}),
  discarded,
  normalizationCounts,
  anomalies,
};

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
const tmpPath = `${outputPath}.tmp`;
const json = JSON.stringify(report, null, 2);
writeFileSync(tmpPath, json, "utf8");
renameSync(tmpPath, outputPath);

console.log(`Reconciliation report written to ${outputPath}`);
console.log(`Total entries: ${report.totalEntries}`);
console.log("Per entity:");
for (const [entity, info] of Object.entries(perEntity)) {
  console.log(`  ${entity}: ${info.count}`);
}
if (prodRows) {
  console.log("Production dry-run rows:");
  for (const row of Object.values(prodRows)) {
    console.log(`  ${row.entity}: expected ${row.expectedCount}, actual ${row.actualCount}`);
  }
}
if (Object.keys(discarded).length > 0) {
  console.log("Discarded (counted but not migrated):");
  for (const [entity, count] of Object.entries(discarded)) {
    console.log(`  ${entity}: ${count} rows`);
  }
}
if (Object.keys(normalizationCounts).length > 0) {
  console.log("Normalization and drift fixes:");
  for (const [section, values] of Object.entries(normalizationCounts).sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${section}:`);
    for (const [name, value] of Object.entries(values).sort(([a], [b]) => a.localeCompare(b))) {
      if (value && typeof value === "object") {
        const parts = Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, count]) => `${key}=${count}`)
          .join(", ");
        console.log(`    ${name}: ${parts}`);
      } else {
        console.log(`    ${name}: ${value}`);
      }
    }
  }
}
if (anomalies.length > 0) {
  console.warn(`Anomalies detected: ${anomalies.length}`);
  for (const a of anomalies) {
    console.warn(`  [${a.type}] ${a.message}`);
  }
  process.exit(1);
} else {
  console.log("No anomalies detected.");
}
