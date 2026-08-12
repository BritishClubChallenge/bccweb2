#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * privacy-scan.mjs — CI success gate: fail if PII leaks into public blobs,
 * SPA bundle, telemetry fixture, or function log fixture.
 *
 * Usage:
 *   node scripts/privacy-scan.mjs
 *   BLOB_CONNECTION_STRING="..." node scripts/privacy-scan.mjs
 *   node scripts/privacy-scan.mjs --source "DefaultEndpointsProtocol=..."
 *   node scripts/privacy-scan.mjs --bundle-patterns "test@example\.com,\+447\d+"
 *
 * Exit codes:
 *   0 — all checks PASS or gracefully skipped
 *   1 — one or more checks FAIL (PII found / violation detected)
 */

import RE2 from "re2";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findPiiInObject, PII_FIELDS } from "./lib/pii.mjs";
import {
  blobStorageIdentity,
  createBlobServiceClient,
  preflightBlobReadAccess,
} from "./lib/storageClients.mjs";

// ─── CLI args ─────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

function getArg(flag) {
  const idx = argv.indexOf(flag);
  return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
}

const sourceArg = getArg("--source");
const bundlePatternsArg = getArg("--bundle-patterns");

const AZURITE_DEV_CS =
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;" +
  "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;" +
  "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";

const CONNECTION_STRING = sourceArg ?? process.env["BLOB_CONNECTION_STRING"] ??
  (process.env["BLOB_STORAGE_ACCOUNT_NAME"] ? undefined : AZURITE_DEV_CS);

const BUNDLE_PATTERNS = bundlePatternsArg
  ? bundlePatternsArg
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
  : [];

// Defence-in-depth cap on operator-supplied --bundle-patterns (PII regexes are
// short, e.g. an email or phone shape). RE2 already guarantees linear-time
// matching, so this only guards against absurd inputs.
const MAX_PATTERN_LENGTH = 200;

const PUBLIC_CONTAINER = process.env["BLOB_CONTAINER_NAME"] ?? "data";

// ─── Result tracking ──────────────────────────────────────────────────────────

let totalViolations = 0;

function pass(check, detail) {
  console.log(`[PASS] ${check}${detail ? `: ${detail}` : ""}`);
}

function skip(check, reason) {
  console.log(`[SKIP] ${check}: ${reason}`);
}

function fail(check, violations) {
  totalViolations += violations.length;
  for (const v of violations) {
    console.error(`[FAIL] ${check}: ${JSON.stringify(v)}`);
  }
}

// ─── Directory walker (Node 24 compatible) ────────────────────────────────────

async function* walkDir(dir, ext) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDir(full, ext);
    } else if (entry.isFile() && full.endsWith(ext)) {
      yield full;
    }
  }
}

// ─── Check 1: Public blob scan ────────────────────────────────────────────────

async function checkPublicBlobs() {
  const CHECK = "public-blob-scan";
  let blobService;
  try {
    blobService = createBlobServiceClient({ connectionString: CONNECTION_STRING });
  } catch (err) {
    fail(CHECK, [{ error: `Cannot build BlobServiceClient: ${err.message}` }]);
    return;
  }

  const container = blobService.getContainerClient(PUBLIC_CONTAINER);
  try {
    await preflightBlobReadAccess({ container, connectionString: CONNECTION_STRING });
  } catch (err) {
    fail(CHECK, [{ error: err instanceof Error ? err.message : "Blob read preflight failed" }]);
    return;
  }

  let scanned = 0;
  const violations = [];

  try {
    for await (const item of container.listBlobsFlat()) {
      if (!item.name.endsWith(".json")) continue;
      scanned++;
      try {
        const client = container.getBlobClient(item.name);
        const response = await client.download();
        const chunks = [];
        for await (const chunk of response.readableStreamBody) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        const hits = findPiiInObject(parsed);
        for (const hit of hits) {
          violations.push({ blob: item.name, path: hit.path, field: hit.field });
        }
      } catch (err) {
        // Parse errors are not a PII violation — log and continue.
        console.warn(`[WARN] ${CHECK}: could not parse ${item.name}: ${err.message}`);
      }
    }
  } catch (err) {
    fail(CHECK, [{ error: `Blob listing failed: ${err.message}` }]);
    return;
  }

  if (violations.length > 0) {
    fail(CHECK, violations);
  } else {
    pass(CHECK, `${scanned} JSON blob(s) scanned, no PII found`);
  }
}

// ─── Check 2: SPA bundle scan ─────────────────────────────────────────────────

async function checkSpaBundle() {
  const CHECK = "spa-bundle-scan";

  if (!existsSync("dist/web")) {
    skip(
      CHECK,
      "dist/web not found — run `make build` first; skipping (exit 0 unaffected)"
    );
    return;
  }

  if (BUNDLE_PATTERNS.length === 0) {
    skip(
      CHECK,
      "no --bundle-patterns provided — regex scan skipped (exit 0 unaffected)"
    );
    return;
  }

  const regexes = BUNDLE_PATTERNS.map((p, index) => {
    if (p.length > MAX_PATTERN_LENGTH) {
      console.warn(
        `[WARN] ${CHECK}: pattern #${index} (${p.length} chars) exceeds ${MAX_PATTERN_LENGTH} chars — skipped`
      );
      return null;
    }
    try {
      // RE2 is a linear-time, backtracking-free regex engine. Compiling the
      // operator-supplied pattern with it (instead of `new RegExp`) means a
      // crafted pattern can't trigger catastrophic backtracking (ReDoS) when
      // matched against large bundle files below.
      return { re: new RE2(p), source: p };
    } catch (err) {
      // Never echo the raw pattern: --bundle-patterns may contain a real PII
      // value (not just a shape), which would leak into CI logs. Log only the
      // index/length plus the compile error.
      console.warn(
        `[WARN] ${CHECK}: invalid regex at pattern #${index} (${p.length} chars) — skipped: ${err.message}`
      );
      return null;
    }
  }).filter(Boolean);

  if (regexes.length === 0) {
    skip(CHECK, "no valid regexes after parsing --bundle-patterns");
    return;
  }

  const violations = [];
  let scanned = 0;

  for await (const filePath of walkDir("dist/web", ".js")) {
    scanned++;
    let content;
    try {
      content = await readFile(filePath, "utf-8");
    } catch (err) {
      console.warn(`[WARN] ${CHECK}: could not read ${filePath}: ${err.message}`);
      continue;
    }
    for (const { re, source } of regexes) {
      const match = content.match(re);
      if (match) {
        violations.push({ file: filePath, pattern: source, match: match[0] });
      }
    }
  }

  if (violations.length > 0) {
    fail(CHECK, violations);
  } else {
    pass(
      CHECK,
      `${scanned} bundle file(s) scanned against ${regexes.length} pattern(s), none matched`
    );
  }
}

// ─── Check 3: App Insights telemetry fixture scan ─────────────────────────────

async function checkTelemetryFixture() {
  const CHECK = "telemetry-fixture-scan";
  const FIXTURE = ".omo/evidence/telemetry-fixture.json";

  if (!existsSync(FIXTURE)) {
    skip(CHECK, `${FIXTURE} not present — Task 46 will populate it (exit 0 unaffected)`);
    return;
  }

  let envelope;
  try {
    const text = await readFile(FIXTURE, "utf-8");
    envelope = JSON.parse(text);
  } catch (err) {
    fail(CHECK, [{ error: `Cannot parse ${FIXTURE}: ${err.message}` }]);
    return;
  }

  const violations = [];

  // Walk the full envelope — customDimensions and baseData are both checked.
  const hits = findPiiInObject(envelope);
  for (const hit of hits) {
    violations.push({ fixture: FIXTURE, path: hit.path, field: hit.field });
  }

  if (violations.length > 0) {
    fail(CHECK, violations);
  } else {
    pass(CHECK, `${FIXTURE} contains no PII fields`);
  }
}

// ─── Check 4: Function logs fixture scan ──────────────────────────────────────

async function checkFunctionLogsFixture() {
  const CHECK = "function-logs-fixture-scan";
  const FIXTURE = ".omo/evidence/function-logs-fixture.txt";

  if (!existsSync(FIXTURE)) {
    skip(
      CHECK,
      `${FIXTURE} not present — populate from log stream manually (exit 0 unaffected)`
    );
    return;
  }

  let text;
  try {
    text = await readFile(FIXTURE, "utf-8");
  } catch (err) {
    fail(CHECK, [{ error: `Cannot read ${FIXTURE}: ${err.message}` }]);
    return;
  }

  const violations = [];

  // Patterns that MUST NOT appear in raw function logs.
  const LOG_FORBIDDEN = [
    { label: "Authorization header value", pattern: /Authorization:\s*Bearer\s+\S+/i },
    { label: "email= query parameter", pattern: /email=\S+@\S+/i },
    { label: "raw JWT token (three-segment base64url)", pattern: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/ },
    { label: "password JSON field", pattern: /"password"\s*:\s*"[^"]+"/i },
    { label: "passwordHash JSON field", pattern: /"passwordHash"\s*:\s*"[^"]+"/i },
    { label: "accessToken JSON field", pattern: /"accessToken"\s*:\s*"[^"]+"/i },
    { label: "refreshToken JSON field", pattern: /"refreshToken"\s*:\s*"[^"]+"/i },
    { label: "verifyToken JSON field", pattern: /"verifyToken"\s*:\s*"[^"]+"/i },
  ];

  for (const { label, pattern } of LOG_FORBIDDEN) {
    const match = text.match(pattern);
    if (match) {
      violations.push({
        fixture: FIXTURE,
        label,
        snippet: match[0].substring(0, 80),
      });
    }
  }

  if (violations.length > 0) {
    fail(CHECK, violations);
  } else {
    pass(CHECK, `${FIXTURE} contains no forbidden PII patterns`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== BCC Privacy Scanner ===");
  console.log(`PII fields under watch: ${PII_FIELDS.join(", ")}`);
  const source = blobStorageIdentity({ connectionString: CONNECTION_STRING });
  console.log(`Blob source: account=${source.accountName ?? "custom"} endpoint=${source.endpoint}`);
  console.log("");

  await checkPublicBlobs();
  await checkSpaBundle();
  await checkTelemetryFixture();
  await checkFunctionLogsFixture();

  console.log("");
  if (totalViolations === 0) {
    console.log("Result: PASS — no PII violations found.");
    process.exit(0);
  } else {
    console.error(`Result: FAIL — ${totalViolations} violation(s) found across all checks.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unexpected scanner error:", err.message);
  process.exit(1);
});
