#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * move-manufacturers-to-public.mjs — one-time operational move of the
 * manufacturers reference list from the PRIVATE blob container to the PUBLIC one.
 *
 * Context:
 *   `manufacturers.json` was historically written to `data-private`. It carries no
 *   PII (id / legacyId / name / websiteUrl only) and the SPA needs to read it
 *   directly, so it belongs in the public `data` container. This script performs
 *   that migration ONCE, AFTER the Function App deploy that starts writing it
 *   publicly. T11 documents it in a runbook.
 *
 * Usage:
 *   node scripts/admin/move-manufacturers-to-public.mjs [--force]
 *
 *   BLOB_CONNECTION_STRING       Azure/Azurite connection string
 *                                (default: Azurite dev — 127.0.0.1:10000)
 *   BLOB_STORAGE_ACCOUNT_NAME    Remote data account (invoking Entra identity)
 *   BLOB_CONTAINER_NAME          public container  (default: "data")
 *   BLOB_PRIVATE_CONTAINER_NAME  private container (default: "data-private")
 *
 * Semantics (private `manufacturers.json` is the source of truth):
 *   0. Private blob ABSENT            → no-op SUCCESS (exit 0). Idempotent: a
 *                                       completed move leaves no private copy, so
 *                                       re-running lands here.
 *   1. Validate the WHOLE list against ManufacturersIndexSchema BEFORE any write.
 *      Invalid JSON / invalid list    → ABORT nonzero, BOTH blobs untouched.
 *   Then, versus the PUBLIC blob:
 *   (a) public ABSENT or `[]`         → write private → public.
 *   (b) public byte-identical to the  → no public write needed; the move is
 *       validated private list          already reflected publicly, so just
 *                                        finish it by removing the private copy
 *                                        (idempotent recovery from an interrupted
 *                                        run). "No-op" refers to the WRITE.
 *   (c) public NON-EMPTY and DIFFERENT → ABORT nonzero, BOTH blobs untouched,
 *                                        UNLESS `--force` (then overwrite public).
 *
 *   delete-after-verify: the private copy is deleted ONLY after the public blob is
 *   confirmed (read back) to hold the exact bytes we intended to write. A failed
 *   verification aborts nonzero and leaves the private copy intact.
 *
 * Exit codes:
 *   0  success / no-op
 *   1  invalid private JSON or schema-validation failure
 *   2  conflict abort (public differs, non-empty, no --force)
 *   3  public write verification failed (read-back mismatch)
 */

import { ManufacturersIndexSchema } from "@bccweb/schemas";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createBlobServiceClient,
  preflightBlobReadAccess,
} from "../lib/storageClients.mjs";

const BLOB_NAME = "manufacturers.json";

const AZURITE_DEV_CS =
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;" +
  "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;" +
  "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";

// ─── Blob helpers (raw text; no lease — this is a one-time maintenance-window
//     operation with no concurrent writers, and the safety guarantees come from
//     validate → conflict-abort → delete-after-verify, not from leasing) ────────

async function readBlobText(container, name) {
  const client = container.getBlobClient(name);
  try {
    const response = await client.download();
    const chunks = [];
    for await (const chunk of response.readableStreamBody) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf-8");
  } catch (err) {
    if (err?.statusCode === 404 || err?.code === "BlobNotFound") return undefined;
    throw err;
  }
}

async function writeBlobText(container, name, text) {
  const client = container.getBlockBlobClient(name);
  await client.upload(text, Buffer.byteLength(text), {
    blobHTTPHeaders: { blobContentType: "application/json" },
  });
}

// ─── Core (pure of process.exit so it is testable / reusable) ──────────────────

/**
 * @returns {Promise<{ code: number, action: string }>}
 */
export async function moveManufacturersToPublic({
  connectionString,
  publicContainer,
  privateContainer,
  force = false,
  log = console.log,
  errlog = console.error,
} = {}) {
  const cs = connectionString ?? process.env["BLOB_CONNECTION_STRING"] ??
    (process.env["BLOB_STORAGE_ACCOUNT_NAME"] ? undefined : AZURITE_DEV_CS);
  const pubName =
    publicContainer ?? process.env["BLOB_CONTAINER_NAME"] ?? "data";
  const privName =
    privateContainer ?? process.env["BLOB_PRIVATE_CONTAINER_NAME"] ?? "data-private";

  const service = createBlobServiceClient({ connectionString: cs });
  const pub = service.getContainerClient(pubName);
  const priv = service.getContainerClient(privName);
  await Promise.all([
    preflightBlobReadAccess({ container: pub, connectionString: cs }),
    preflightBlobReadAccess({ container: priv, connectionString: cs }),
  ]);

  // ── 0. Read private (source of truth) ───────────────────────────────────────
  const privateRaw = await readBlobText(priv, BLOB_NAME);
  if (privateRaw === undefined) {
    log(`[move] No private ${BLOB_NAME} found — nothing to move (no-op success).`);
    return { code: 0, action: "noop-absent-private" };
  }

  // ── 1. Parse + validate the WHOLE list BEFORE any write ─────────────────────
  let privateJson;
  try {
    privateJson = JSON.parse(privateRaw);
  } catch (err) {
    errlog(
      `[move] Private ${BLOB_NAME} is not valid JSON: ${err.message}. ` +
        `Aborting — both blobs left untouched.`
    );
    return { code: 1, action: "abort-invalid-json" };
  }

  const parsed = ManufacturersIndexSchema.safeParse(privateJson);
  if (!parsed.success) {
    errlog(
      `[move] Private ${BLOB_NAME} failed ManufacturersIndexSchema validation. ` +
        `Aborting — both blobs left untouched. Offending path(s) (no values):`
    );
    // Log paths + codes only — never field values.
    for (const issue of parsed.error.issues) {
      const path = issue.path.length ? issue.path.join(".") : "(root)";
      errlog(`  - ${path}: ${issue.code}`);
    }
    return { code: 1, action: "abort-schema-invalid" };
  }

  const validated = parsed.data;
  const outputContent = JSON.stringify(validated, null, 2);

  // ── 2. Read public + decide (conflict semantics) ────────────────────────────
  const publicRaw = await readBlobText(pub, BLOB_NAME);

  let decision; // "write" | "already"
  if (publicRaw === undefined) {
    decision = "write"; // (a) public absent
    log(
      `[move] Public ${BLOB_NAME} absent → writing ${validated.length} manufacturer(s).`
    );
  } else {
    let publicJson;
    try {
      publicJson = JSON.parse(publicRaw);
    } catch {
      publicJson = undefined; // unparseable public → not empty, treat as conflict below
    }

    if (Array.isArray(publicJson) && publicJson.length === 0) {
      decision = "write"; // (a) public is []
      log(
        `[move] Public ${BLOB_NAME} is empty [] → writing ${validated.length} manufacturer(s).`
      );
    } else if (publicRaw === outputContent) {
      decision = "already"; // (b) byte-identical to what we would write
      log(
        `[move] Public ${BLOB_NAME} is already byte-identical to the validated ` +
          `private list — no public write needed; completing the move.`
      );
    } else {
      // (c) public non-empty AND different
      if (force) {
        decision = "write";
        log(
          `[move] Public ${BLOB_NAME} differs and is non-empty; --force given → overwriting.`
        );
      } else {
        errlog(
          `[move] CONFLICT: public ${BLOB_NAME} is non-empty and differs from the ` +
            `private list. Refusing to overwrite without --force. ` +
            `Both blobs left untouched.`
        );
        return { code: 2, action: "abort-conflict" };
      }
    }
  }

  // ── 3. Write (if needed) + verify (delete-after-verify) ─────────────────────
  if (decision === "write") {
    await writeBlobText(pub, BLOB_NAME, outputContent);
    const readback = await readBlobText(pub, BLOB_NAME);
    if (readback !== outputContent) {
      errlog(
        `[move] Public write verification FAILED (read-back mismatch). ` +
          `Private copy left INTACT for safety.`
      );
      return { code: 3, action: "abort-verify-failed" };
    }
    log(
      `[move] Public ${BLOB_NAME} written and verified (${validated.length} manufacturer(s)).`
    );
  }

  // Public is now confirmed to hold the data (either freshly written+verified, or
  // pre-existing and byte-identical) → safe to remove the private copy.
  await priv.getBlobClient(BLOB_NAME).deleteIfExists();
  log(`[move] Deleted private ${BLOB_NAME}. Move complete.`);

  return {
    code: 0,
    action: decision === "already" ? "completed-already-identical" : "moved",
  };
}

// ─── CLI entrypoint (only when invoked directly, not when imported) ────────────

function invokedAsScript() {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    return entry === self;
  }
}

if (invokedAsScript()) {
  const force = process.argv.slice(2).includes("--force");
  moveManufacturersToPublic({ force })
    .then((result) => process.exit(result.code))
    .catch((err) => {
      console.error(`[move] Fatal error: ${err?.message ?? err}`);
      process.exit(1);
    });
}
