// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * Azurite lifecycle for API integration tests.
 *
 * - beforeAll: create both containers ("data", "data-private") in Azurite
 *
 * Requires Azurite running locally (docker-compose up azurite).
 * Uses BLOB_CONNECTION_STRING defaulting to the Azurite dev connection string.
 *
 * Per-file container isolation: each test file gets its own
 * test-data-<rand>/test-priv-<rand> containers. resetBlobSingletons()
 * ensures the lib/blob.ts module re-reads BLOB_CONTAINER_NAME from env
 * so isolation is correct regardless of vitest pool config
 * (singleThread/singleFork would otherwise reuse the first file's
 * containers silently).
 */

import { randomBytes } from "node:crypto";
import { BlobServiceClient, ContainerClient } from "@azure/storage-blob";
import { afterAll, beforeAll, expect } from "vitest";
import { resetBlobSingletons } from "../../lib/blob.js";

const usesAzurite = !expect
  .getState()
  .testPath?.endsWith("/storageClients.test.ts");

// MODULE SCOPE: must run before any test imports of lib/blob.ts read these envs.
const suffix = randomBytes(6).toString("hex");
export const PUBLIC_CONTAINER = "test-data-" + suffix;
export const PRIVATE_CONTAINER = "test-priv-" + suffix;
process.env.BLOB_CONTAINER_NAME = PUBLIC_CONTAINER;
process.env.BLOB_PRIVATE_CONTAINER_NAME = PRIVATE_CONTAINER;

// Azurite well-known development connection string
const AZURITE_CONNECTION_STRING =
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;" +
  "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;" +
  "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";

export const CONNECTION_STRING =
  process.env["BLOB_CONNECTION_STRING"] ?? AZURITE_CONNECTION_STRING;

let blobService: BlobServiceClient;
let publicContainer: ContainerClient;
let privateContainer: ContainerClient;

export function getBlobService(): BlobServiceClient {
  return blobService;
}

export function getPublicContainer(): ContainerClient {
  return publicContainer;
}

export function getPrivateContainer(): ContainerClient {
  return privateContainer;
}

/**
 * Best-effort sweep of stale `test-*` containers older than 1h.
 *
 * SAFETY: only runs when CONNECTION_STRING targets a local Azurite endpoint
 * (127.0.0.1 or localhost). Never sweep against real Azure storage accounts.
 * Sweep failures are logged and swallowed — they must never fail tests.
 */
async function sweepStaleTestContainers(
  svc: BlobServiceClient,
): Promise<void> {
  if (
    !CONNECTION_STRING.includes("127.0.0.1") &&
    !CONNECTION_STRING.includes("localhost")
  ) {
    return;
  }

  const oneHourMs = 60 * 60 * 1000;
  const cutoff = Date.now() - oneHourMs;

  try {
    for await (const c of svc.listContainers()) {
      if (!c.name.startsWith("test-")) continue;
      const lm = c.properties?.lastModified;
      const ts = lm ? new Date(lm).getTime() : NaN;
      if (!Number.isFinite(ts) || ts > cutoff) continue;
      try {
        await svc.getContainerClient(c.name).deleteIfExists();
      } catch (err) {
        // Best-effort — log and continue.
         
        console.warn(`[azurite-sweep] failed to delete ${c.name}:`, err);
      }
    }
  } catch (err) {
     
    console.warn("[azurite-sweep] listContainers failed:", err);
  }
}

// ─── Lifecycle hooks ─────────────────────────────────────────────────────────

beforeAll(async () => {
  if (!usesAzurite) return;
  blobService = BlobServiceClient.fromConnectionString(CONNECTION_STRING);

  // Sweep stale test-* containers BEFORE creating ours. Best-effort.
  await sweepStaleTestContainers(blobService);

  // Re-initialize lib/blob.ts singletons so they re-read the env vars set
  // at module scope above. Without this, vitest pool configs like
  // singleThread/singleFork would share the first file's containers.
  resetBlobSingletons();

  publicContainer = blobService.getContainerClient(PUBLIC_CONTAINER);
  privateContainer = blobService.getContainerClient(PRIVATE_CONTAINER);

  // Create containers idempotently
  await publicContainer.createIfNotExists({ access: "blob" });
  await privateContainer.createIfNotExists();
});

afterAll(async () => {
  if (!usesAzurite) return;
  await Promise.all([
    publicContainer.deleteIfExists(),
    privateContainer.deleteIfExists(),
  ]);
});
