#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * fix-snapshots.mjs
 *
 * Normalizes PilotSnapshot.wingManufacturer in existing round blobs.
 *
 * Before Task 24 was fixed, migrate.mjs wrote wingManufacturer as the
 * manufacturer UUID instead of the manufacturer name string. This script
 * detects those UUID values and replaces them with the correct name.
 *
 * Usage:
 *   node scripts/migrate/fix-snapshots.mjs           # dry-run (default — no writes)
 *   node scripts/migrate/fix-snapshots.mjs --apply   # apply changes
 *
 * Idempotent: running twice always produces "0 fixes needed" on the second run.
 */

import { createBlobServiceClient } from "./blobClient.mjs";

const APPLY = process.argv.includes("--apply");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const blobService = createBlobServiceClient();
const privateContainer = blobService.getContainerClient("data-private");

async function readJson(path) {
  const client = privateContainer.getBlobClient(path);
  const response = await client.download();
  const chunks = [];
  for await (const chunk of response.readableStreamBody) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

async function writeJson(path, data) {
  const content = JSON.stringify(data, null, 2);
  const blockClient = privateContainer.getBlockBlobClient(path);
  await blockClient.upload(content, Buffer.byteLength(content), {
    blobHTTPHeaders: { blobContentType: "application/json" },
    overwrite: true,
  });
}

async function main() {
  console.log(`fix-snapshots.mjs — ${APPLY ? "APPLY" : "dry-run"}\n`);

  const mfrNameByUuid = new Map();
  for await (const blob of privateContainer.listBlobsFlat({ prefix: "manufacturers/" })) {
    if (!blob.name.endsWith(".json") || blob.name === "manufacturers.json") continue;
    try {
      const mfr = await readJson(blob.name);
      if (mfr.id && mfr.name) mfrNameByUuid.set(mfr.id, mfr.name);
    } catch {
      // ignore unreadable blobs
    }
  }
  console.log(`Loaded ${mfrNameByUuid.size} manufacturer name mappings\n`);

  let fixCount = 0;
  let skipCount = 0;
  let errorCount = 0;

  for await (const blob of privateContainer.listBlobsFlat({ prefix: "rounds/" })) {
    if (!blob.name.endsWith(".json")) continue;
    try {
      const round = await readJson(blob.name);
      let changed = false;
      for (const team of round.teams ?? []) {
        for (const slot of team.pilots ?? []) {
          const wm = slot.snapshot?.wingManufacturer;
          if (wm && UUID_RE.test(wm)) {
            const name = mfrNameByUuid.get(wm);
            if (name) {
              slot.snapshot.wingManufacturer = name;
              changed = true;
            } else {
              console.warn(`  WARN: UUID ${wm} not found in manufacturer list (${blob.name})`);
            }
          }
        }
      }
      if (changed) {
        fixCount++;
        if (APPLY) {
          await writeJson(blob.name, round);
          console.log(`  FIXED: ${blob.name}`);
        } else {
          console.log(`  [dry-run] would fix: ${blob.name}`);
        }
      } else {
        skipCount++;
      }
    } catch (err) {
      errorCount++;
      console.error(`  ERROR: ${blob.name}: ${err.message}`);
    }
  }

  const verb = APPLY ? "" : " (dry-run — pass --apply to write)";
  console.log(`\nSummary: ${fixCount} fixes needed${verb}, ${skipCount} already correct, ${errorCount} errors`);
  if (fixCount === 0) console.log("0 fixes needed");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
