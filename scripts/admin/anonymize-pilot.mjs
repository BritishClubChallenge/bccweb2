#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * anonymize-pilot.mjs — GDPR Article 17 right-to-erasure for a single pilot.
 *
 * Usage:
 *   GDPR_ANONYMIZE_CONFIRM=YES \
 *   BLOB_STORAGE_ACCOUNT_NAME="stbccwebstagingdata" \
 *   node scripts/admin/anonymize-pilot.mjs --pilotId <uuid> --confirm
 *
 * Guards (both required to prevent accidental execution):
 *   --confirm flag           must be present on the command line
 *   GDPR_ANONYMIZE_CONFIRM=YES  must be set in the environment
 *
 * What is anonymised:
 *   pilots/{pilotId}.json  (private) — PII fields nulled; name replaced with [REDACTED]
 *   user-index.json        (private) — email→userId entry removed
 *   users/{userId}.json    (private) — blob deleted
 *   auth/{userId}.json     (private) — blob deleted
 *
 * What is preserved (historical record / legal obligation):
 *   rounds/{id}.json       PilotSnapshot frozen at lock time; not touched
 *   results/{year}.json    League positions; not touched
 *   signatures/...         Audit trail; not touched
 *   pilots.json (public)   PilotSummary entry name set to [REDACTED]
 *
 * Audit trail:
 *   .omo/evidence/gdpr/anonymize-{pilotId}-{date}.json
 *   Contains: blobs touched, field names (NOT values) changed, timestamp, operator.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  createBlobServiceClient,
  preflightBlobReadAccess,
} from "../lib/storageClients.mjs";

// ─── Guards ───────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

function getArg(flag) {
  const idx = argv.indexOf(flag);
  return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
}

const pilotId = getArg("--pilotId");
const hasConfirm = argv.includes("--confirm");
const envConfirm = process.env["GDPR_ANONYMIZE_CONFIRM"] === "YES";

if (!pilotId) {
  console.error("Error: --pilotId <uuid> is required.");
  process.exit(1);
}

if (!hasConfirm || !envConfirm) {
  console.error(
    "Error: GDPR anonymization refused. Both of the following are required:"
  );
  console.error("  1. --confirm flag on the command line");
  console.error("  2. GDPR_ANONYMIZE_CONFIRM=YES environment variable");
  console.error("");
  console.error(
    "This double-lock prevents accidental erasure. Ensure this request has been"
  );
  console.error(
    "approved by the data controller before proceeding (see docs/runbooks/gdpr-erasure.md)."
  );
  process.exit(1);
}

// ─── Blob storage setup ───────────────────────────────────────────────────────

const AZURITE_DEV_CS =
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;" +
  "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;" +
  "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";

const CONNECTION_STRING = process.env["BLOB_CONNECTION_STRING"] ??
  (process.env["BLOB_STORAGE_ACCOUNT_NAME"] ? undefined : AZURITE_DEV_CS);

const PUBLIC_CONTAINER = process.env["BLOB_CONTAINER_NAME"] ?? "data";
const PRIVATE_CONTAINER = process.env["BLOB_PRIVATE_CONTAINER_NAME"] ?? "data-private";

const blobService = createBlobServiceClient({ connectionString: CONNECTION_STRING });
const pub = blobService.getContainerClient(PUBLIC_CONTAINER);
const priv = blobService.getContainerClient(PRIVATE_CONTAINER);

// ─── Blob helpers ─────────────────────────────────────────────────────────────

async function readPrivateJson(path) {
  const client = priv.getBlobClient(path);
  const response = await client.download();
  const chunks = [];
  for await (const chunk of response.readableStreamBody) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

async function writePrivateJson(path, data, leaseId) {
  const client = priv.getBlockBlobClient(path);
  const content = JSON.stringify(data, null, 2);
  const options = leaseId ? { conditions: { leaseId } } : undefined;
  await client.upload(content, Buffer.byteLength(content), {
    blobHTTPHeaders: { blobContentType: "application/json" },
    conditions: options?.conditions,
  });
}

async function readPublicJson(path) {
  const client = pub.getBlobClient(path);
  const response = await client.download();
  const chunks = [];
  for await (const chunk of response.readableStreamBody) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

async function writePublicJson(path, data, leaseId) {
  const client = pub.getBlockBlobClient(path);
  const content = JSON.stringify(data, null, 2);
  const options = leaseId ? { conditions: { leaseId } } : undefined;
  await client.upload(content, Buffer.byteLength(content), {
    blobHTTPHeaders: { blobContentType: "application/json" },
    conditions: options?.conditions,
  });
}

async function withPrivateLease(path, fn) {
  const client = priv.getBlockBlobClient(path);
  const leaseClient = client.getBlobLeaseClient();
  const response = await leaseClient.acquireLease(30);
  const leaseId = response.leaseId;
  if (!leaseId) throw new Error(`Failed to acquire lease on ${path}`);
  try {
    const result = await fn(leaseId);
    await leaseClient.releaseLease();
    return result;
  } catch (err) {
    await leaseClient.releaseLease().catch(() => {});
    throw err;
  }
}

async function withPublicLease(path, fn) {
  const client = pub.getBlockBlobClient(path);
  const leaseClient = client.getBlobLeaseClient();
  const response = await leaseClient.acquireLease(30);
  const leaseId = response.leaseId;
  if (!leaseId) throw new Error(`Failed to acquire lease on ${path}`);
  try {
    const result = await fn(leaseId);
    await leaseClient.releaseLease();
    return result;
  } catch (err) {
    await leaseClient.releaseLease().catch(() => {});
    throw err;
  }
}

async function deletePrivateBlob(path) {
  const client = priv.getBlobClient(path);
  try {
    await client.deleteIfExists();
  } catch (err) {
    console.warn(`[WARN] Could not delete ${path}: ${err.message}`);
  }
}

// ─── PII fields to null on the Pilot record ───────────────────────────────────

const PILOT_NULL_FIELDS = [
  "bhpaNumber",
  "medicalInfo",
  "emergencyContactName",
  "emergencyPhoneNumber",
  "helmetColour",
  "harnessType",
  "harnessColour",
  "wingModel",
  "wingColours",
  "pureTrackId",
  "pureTrackLink",
];

// person sub-object fields to anonymise
const PERSON_NULL_FIELDS = ["phoneNumber"];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const runAt = new Date().toISOString();
  const dateStamp = runAt.slice(0, 10);
  const blobsTouched = [];
  const fieldsChanged = [];

  console.log(`[GDPR] Starting anonymization for pilotId=${pilotId}`);
  console.log(`[GDPR] Timestamp: ${runAt}`);

  await Promise.all([
    preflightBlobReadAccess({ container: pub, connectionString: CONNECTION_STRING }),
    preflightBlobReadAccess({ container: priv, connectionString: CONNECTION_STRING }),
  ]);

  // ── Step 1: Read pilot private blob ─────────────────────────────────────────

  const pilotPath = `pilots/${pilotId}.json`;
  let pilot;
  try {
    pilot = await readPrivateJson(pilotPath);
  } catch (err) {
    console.error(`[GDPR] Cannot read ${pilotPath}: ${err.message}`);
    console.error("[GDPR] Aborting — no changes made.");
    process.exit(1);
  }

  const userId = pilot.userId ?? null;

  console.log(`[GDPR] Found pilot. userId=${userId}, email=[hidden]`);

  // ── Step 2: Anonymise pilot private blob ─────────────────────────────────────

  await withPrivateLease(pilotPath, async (leaseId) => {
    const fresh = await readPrivateJson(pilotPath);

    // Anonymise name fields
    if (fresh.person) {
      if (fresh.person.firstName) {
        fresh.person.firstName = "[REDACTED]";
        fieldsChanged.push("person.firstName");
      }
      if (fresh.person.lastName) {
        fresh.person.lastName = "[REDACTED]";
        fieldsChanged.push("person.lastName");
      }
      if (fresh.person.fullName) {
        fresh.person.fullName = "[REDACTED]";
        fieldsChanged.push("person.fullName");
      }
      for (const field of PERSON_NULL_FIELDS) {
        if (fresh.person[field] != null) {
          fresh.person[field] = null;
          fieldsChanged.push(`person.${field}`);
        }
      }
    }

    // Null out PII fields on the pilot root
    for (const field of PILOT_NULL_FIELDS) {
      if (fresh[field] != null) {
        fresh[field] = null;
        fieldsChanged.push(field);
      }
    }

    // Remove userId association so the pilot cannot be re-linked
    fresh.userId = null;
    fieldsChanged.push("userId");

    fresh.updatedAt = runAt;
    fresh.updatedBy = "gdpr-erasure";

    await writePrivateJson(pilotPath, fresh, leaseId);
    blobsTouched.push({ blob: pilotPath, action: "anonymised" });
    console.log(`[GDPR] Anonymised ${pilotPath}`);
  });

  // ── Step 3: Update public pilot index (pilots.json) ──────────────────────────

  try {
    await withPublicLease("pilots.json", async (leaseId) => {
      const index = await readPublicJson("pilots.json");
      if (Array.isArray(index)) {
        const entry = index.find((p) => p.id === pilotId);
        if (entry) {
          entry.name = "[REDACTED]";
          await writePublicJson("pilots.json", index, leaseId);
          blobsTouched.push({ blob: "pilots.json (public)", action: "name set to [REDACTED]" });
          console.log("[GDPR] Updated public pilots.json index");
        } else {
          console.log("[GDPR] Pilot not found in public pilots.json index — skipping");
        }
      }
    });
  } catch (err) {
    // Not fatal if the public index doesn't exist yet
    console.warn(`[GDPR] Could not update public pilots.json: ${err.message}`);
  }

  // ── Step 4: Remove email entry from user-index.json ──────────────────────────

  if (userId) {
    try {
      await withPrivateLease("user-index.json", async (leaseId) => {
        const index = await readPrivateJson("user-index.json");
        // user-index is email → userId map; find the email key for this userId
        let removedKey = null;
        for (const [email, uid] of Object.entries(index)) {
          if (uid === userId) {
            removedKey = email;
            break;
          }
        }
        if (removedKey) {
          delete index[removedKey];
          await writePrivateJson("user-index.json", index, leaseId);
          blobsTouched.push({ blob: "user-index.json", action: "email entry removed (key redacted)" });
          console.log("[GDPR] Removed email from user-index.json");
        } else {
          console.log("[GDPR] No entry found in user-index.json for this userId");
        }
      });
    } catch (err) {
      console.warn(`[GDPR] Could not update user-index.json: ${err.message}`);
    }
  }

  // ── Step 5: Delete user and auth blobs ───────────────────────────────────────

  if (userId) {
    const userPath = `users/${userId}.json`;
    await deletePrivateBlob(userPath);
    blobsTouched.push({ blob: userPath, action: "deleted" });
    console.log(`[GDPR] Deleted ${userPath}`);

    const authPath = `auth/${userId}.json`;
    await deletePrivateBlob(authPath);
    blobsTouched.push({ blob: authPath, action: "deleted" });
    console.log(`[GDPR] Deleted ${authPath}`);

    // Also remove any short-lived auth tokens for this user
    // These are stored at auth/tokens/{hash}.json and are TTL-GC'd anyway,
    // but we attempt a best-effort listing and deletion.
    try {
      const tokenPrefix = `auth/tokens/`;
      for await (const item of priv.listBlobsFlat({ prefix: tokenPrefix })) {
        try {
          const tokenBlob = await readPrivateJson(item.name);
          if (tokenBlob.userId === userId) {
            await deletePrivateBlob(item.name);
            blobsTouched.push({ blob: item.name, action: "auth token deleted" });
          }
        } catch {
          // Token blob may already be consumed/expired — skip
        }
      }
    } catch (err) {
      console.warn(`[GDPR] Could not enumerate auth tokens: ${err.message}`);
    }
  }

  // ── Step 6: Write audit log ───────────────────────────────────────────────────

  const auditDir = ".omo/evidence/gdpr";
  if (!existsSync(auditDir)) {
    await mkdir(auditDir, { recursive: true });
  }

  const auditPath = join(
    auditDir,
    `anonymize-${pilotId}-${dateStamp}.json`
  );
  const auditRecord = {
    pilotId,
    userId,
    ranAt: runAt,
    operator: process.env["USER"] ?? "unknown",
    blobsTouched,
    // Log field NAMES only — never values.
    fieldsAnonymised: fieldsChanged,
    preservedBlobs: [
      "rounds/{id}.json (PilotSnapshot preserved at lock-time values)",
      "results/{year}.json (league positions preserved)",
      "signatures/{id}.json (audit trail preserved)",
    ],
  };
  await writeFile(auditPath, JSON.stringify(auditRecord, null, 2), "utf-8");
  console.log(`[GDPR] Audit log written to ${auditPath}`);

  console.log("");
  console.log(`[GDPR] Anonymization complete for pilotId=${pilotId}`);
  console.log(`[GDPR] Blobs touched: ${blobsTouched.length}`);
  console.log(`[GDPR] Fields anonymised: ${fieldsChanged.join(", ")}`);
}

main().catch((err) => {
  console.error("[GDPR] Fatal error:", err.message);
  process.exit(1);
});
