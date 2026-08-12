// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  summarizeSqlConnectionString,
  summarizeStorageConnectionString,
} from "../connectionSummary.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const MIGRATE_DIR = resolve(TEST_DIR, "..");
const DRY_RUN_SCRIPT = resolve(MIGRATE_DIR, "dry-run-against-prod.sh");
const BACPAC_SCRIPT = resolve(MIGRATE_DIR, "validate-against-bacpac.sh");

function printConfig(script, environment) {
  return spawnSync("bash", [script, "--print-config"], {
    env: { ...process.env, ...environment },
    encoding: "utf8",
  });
}

function fullOutput(result) {
  return `${result.stdout}${result.stderr}`;
}

describe("migration wrapper connection summaries", () => {
  test("storage summary contains only a derived account and sanitized endpoint", () => {
    const signature = "summary-signature-that-must-not-appear%3D";
    const connection = `BlobEndpoint=https://user:password@example.blob.core.windows.net/path?sig=${signature}#fragment`;

    const summary = summarizeStorageConnectionString(connection);
    const serialized = JSON.stringify(summary);

    assert.deepEqual(summary, {
      accountName: "example",
      endpoint: "https://example.blob.core.windows.net/path",
    });
    assert.equal(serialized.includes(signature), false);
    assert.equal(serialized.includes("user:password"), false);
  });

  test("SQL summary contains only server and database for quoted credentials", () => {
    const password = "quoted;password-that-must-not-appear";
    const connection = `Data Source=sql.example;Initial Catalog=Bcc;User Id=operator;Password="${password}";`;

    const summary = summarizeSqlConnectionString(connection);
    const serialized = JSON.stringify(summary);

    assert.deepEqual(summary, { server: "sql.example", database: "Bcc" });
    assert.equal(serialized.includes(password), false);
    assert.equal(serialized.includes("operator"), false);
  });

  test("dry-run output excludes every field of a realistic service SAS", () => {
    const signature = "dry-run-signature-value%3D";
    const connection = "BlobEndpoint=https://example.blob.core.windows.net/;" +
      `SharedAccessSignature=sv=2026-01-01&ss=b&srt=sco&sp=racwdl&se=2027-01-01&sig=${signature}`;

    const result = printConfig(DRY_RUN_SCRIPT, { STAGING_BLOB_CONN: connection });
    const output = fullOutput(result);

    assert.equal(result.status, 0, output);
    assert.equal(output.includes(signature), false);
    assert.equal(output.includes("sp=racwdl"), false);
  });

  test("BACPAC output strips a SAS query from an explicit Blob endpoint", () => {
    const signature = "endpoint-query-signature%3D";
    const connection = `BlobEndpoint=https://user:password@example.blob.core.windows.net/path?sv=2026-01-01&sig=${signature}#fragment`;

    const result = printConfig(BACPAC_SCRIPT, { BACPAC_BLOB_CONN: connection });
    const output = fullOutput(result);

    assert.equal(result.status, 0, output);
    assert.equal(output.includes(signature), false);
    assert.equal(output.includes("user:password"), false);
    assert.equal(output.includes("#fragment"), false);
  });

  test("wrapper output excludes an account key", () => {
    const accountKey = "account-key-value-that-must-not-appear";
    const connection = `DefaultEndpointsProtocol=https;AccountName=example;AccountKey=${accountKey}`;

    const result = printConfig(DRY_RUN_SCRIPT, { STAGING_BLOB_CONN: connection });
    const output = fullOutput(result);

    assert.equal(result.status, 0, output);
    assert.equal(output.includes(accountKey), false);
  });

  test("wrappers do not pass storage connection strings to child-process arguments", () => {
    const sources = [DRY_RUN_SCRIPT, BACPAC_SCRIPT]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");

    assert.doesNotMatch(sources, /--source\s+["']?\$[^\s]+CONN/);
    assert.doesNotMatch(sources, /--connection-string/);
    assert.doesNotMatch(sources, /process\.argv\[[^\]]+\].*(?:CONN|connection)/i);
  });
});
