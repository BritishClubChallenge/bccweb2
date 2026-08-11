// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { fromConnectionString } = vi.hoisted(() => ({
  fromConnectionString: vi.fn((connectionString: string) => ({
    connectionString,
    getContainerClient: vi.fn((containerName: string) => ({
      connectionString,
      containerName,
      getBlobClient: vi.fn(() => ({ containerName })),
      getBlockBlobClient: vi.fn(() => ({ containerName })),
    })),
  })),
}));

vi.mock("@azure/storage-blob", () => ({
  BlobServiceClient: {
    fromConnectionString,
  },
}));

describe("resetBlobSingletons", () => {
  // Save the blob-related env so this file is self-contained and leaves no
  // deleted env behind. Earlier this afterEach did `delete process.env.*`,
  // leaving the container-name env vars unset for any later test in the file
  // (or an accidental ordering change). blob.ts now fails loud when those vars
  // are unset, so such a test would crash rather than silently fall through —
  // but snapshotting in beforeEach and restoring in afterEach keeps the env
  // intact and the file hermetic regardless.
  let savedEnv: {
    conn: string | undefined;
    pub: string | undefined;
    priv: string | undefined;
  };

  beforeEach(() => {
    savedEnv = {
      conn: process.env.BLOB_CONNECTION_STRING,
      pub: process.env.BLOB_CONTAINER_NAME,
      priv: process.env.BLOB_PRIVATE_CONTAINER_NAME,
    };
    // Reset the module registry so the dynamic import below re-loads blob.js
    // with the mocked @azure/storage-blob in place. Without this, blob.js is
    // cached from earlier setup-file imports and still references the real
    // package — making the mock invisible.
    vi.resetModules();
    fromConnectionString.mockClear();
  });

  afterEach(() => {
    const restore = (key: string, val: string | undefined) => {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    };
    restore("BLOB_CONNECTION_STRING", savedEnv.conn);
    restore("BLOB_CONTAINER_NAME", savedEnv.pub);
    restore("BLOB_PRIVATE_CONTAINER_NAME", savedEnv.priv);
  });

  test("re-reads BLOB_CONNECTION_STRING after reset", async () => {
    process.env.BLOB_CONNECTION_STRING = "UseDevelopmentStorage=true;first";
    process.env.BLOB_CONTAINER_NAME = "data";

    const { getBlobClient, resetBlobSingletons } = await import("../blob.js");

    getBlobClient("rounds/one.json");
    expect(fromConnectionString).toHaveBeenCalledTimes(1);
    expect(fromConnectionString).toHaveBeenCalledWith(
      "UseDevelopmentStorage=true;first"
    );

    process.env.BLOB_CONNECTION_STRING = "UseDevelopmentStorage=true;second";
    getBlobClient("rounds/two.json");
    expect(fromConnectionString).toHaveBeenCalledTimes(1);

    resetBlobSingletons();
    getBlobClient("rounds/three.json");
    expect(fromConnectionString).toHaveBeenCalledTimes(2);
    expect(fromConnectionString).toHaveBeenLastCalledWith(
      "UseDevelopmentStorage=true;second"
    );
  });

  test("resets the shared storage-client seam", async () => {
    // Given
    const resetStorageClientSingletons = vi.fn();
    vi.doMock("../storageClients.js", () => ({
      getBlobServiceClient: vi.fn(),
      resetStorageClientSingletons,
    }));
    const { resetBlobSingletons } = await import("../blob.js");

    // When
    resetBlobSingletons();

    // Then
    expect(resetStorageClientSingletons).toHaveBeenCalledOnce();
    vi.doUnmock("../storageClients.js");
  });

  // ─── Fail-loud container-name contract ──────────────────────────────────────
  // With a valid connection string but NO container name, resolving a client
  // must throw an error that names the missing env var instead of silently
  // falling back to "data"/"data-private".

  test("PUBLIC client throws naming BLOB_CONTAINER_NAME when it is unset", async () => {
    process.env.BLOB_CONNECTION_STRING = "UseDevelopmentStorage=true;public";
    delete process.env.BLOB_CONTAINER_NAME;

    const { getBlobClient } = await import("../blob.js");

    expect(() => getBlobClient("rounds/one.json")).toThrow(
      /BLOB_CONTAINER_NAME/
    );
  });

  test("PRIVATE client throws naming BLOB_PRIVATE_CONTAINER_NAME when it is unset", async () => {
    process.env.BLOB_CONNECTION_STRING = "UseDevelopmentStorage=true;private";
    delete process.env.BLOB_PRIVATE_CONTAINER_NAME;

    const { getPrivateBlobClient } = await import("../blob.js");

    expect(() => getPrivateBlobClient("pilots/one.json")).toThrow(
      /BLOB_PRIVATE_CONTAINER_NAME/
    );
  });

  // ─── Per-file isolation mechanism must survive fail-loud ────────────────────
  // helpers/azurite.ts sets BLOB_CONTAINER_NAME="test-data-<rand>" then calls
  // resetBlobSingletons(). The fail-loud check must only trigger on a genuinely
  // unset name — when a name IS set, the client must resolve THAT container.

  test("resolves the explicitly-set container name after reset (isolation)", async () => {
    process.env.BLOB_CONNECTION_STRING = "UseDevelopmentStorage=true;iso";
    process.env.BLOB_CONTAINER_NAME = "data";

    const { getBlobClient, resetBlobSingletons } = await import("../blob.js");

    // First resolution caches the original container.
    getBlobClient("rounds/one.json");

    // Simulate per-file isolation: reset + set the random per-file container.
    resetBlobSingletons();
    process.env.BLOB_CONTAINER_NAME = "test-data-abc";

    const client = getBlobClient("rounds/two.json") as unknown as {
      containerName: string;
    };
    expect(client.containerName).toBe("test-data-abc");
  });
});
