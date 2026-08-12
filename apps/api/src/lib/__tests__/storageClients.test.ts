// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  getBlobServiceClient,
  getRuntimeQueueClient,
  resetStorageClientSingletons,
  StorageConfigError,
} from "../storageClients.js";

const AZURITE_CONNECTION_STRING =
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;" +
  "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;" +
  "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;" +
  "QueueEndpoint=http://127.0.0.1:10001/devstoreaccount1;";

const STORAGE_ENV_KEYS = [
  "BLOB_CONNECTION_STRING",
  "AzureWebJobsStorage",
  "BLOB_STORAGE_ACCOUNT_NAME",
  "RUNTIME_STORAGE_ACCOUNT_NAME",
  "STORAGE_UMI_CLIENT_ID",
] as const;

describe("storage clients", () => {
  beforeEach(() => {
    for (const key of STORAGE_ENV_KEYS) vi.stubEnv(key, undefined);
    resetStorageClientSingletons();
  });

  afterEach(() => {
    resetStorageClientSingletons();
    vi.unstubAllEnvs();
  });

  test("builds the blob client from BLOB_CONNECTION_STRING when configured", () => {
    // Given
    vi.stubEnv("BLOB_CONNECTION_STRING", AZURITE_CONNECTION_STRING);

    // When
    const client = getBlobServiceClient();

    // Then
    expect(client.accountName).toBe("devstoreaccount1");
    expect(client.url).toBe("http://127.0.0.1:10000/devstoreaccount1");
  });

  test("builds the queue client from AzureWebJobsStorage when configured", () => {
    // Given
    vi.stubEnv("AzureWebJobsStorage", AZURITE_CONNECTION_STRING);

    // When
    const client = getRuntimeQueueClient("round-brief-pdf");

    // Then
    expect(client.accountName).toBe("devstoreaccount1");
    expect(client.url).toBe(
      "http://127.0.0.1:10001/devstoreaccount1/round-brief-pdf",
    );
  });

  test("uses the data account for the managed-identity blob client", () => {
    // Given
    vi.stubEnv("BLOB_STORAGE_ACCOUNT_NAME", "stbccwebstagingdata");
    vi.stubEnv("RUNTIME_STORAGE_ACCOUNT_NAME", "stbccwebstagingrt");
    vi.stubEnv("STORAGE_UMI_CLIENT_ID", "00000000-0000-0000-0000-000000000001");

    // When
    const client = getBlobServiceClient();

    // Then
    expect(client.url).toBe("https://stbccwebstagingdata.blob.core.windows.net/");
  });

  test("uses the runtime account for the managed-identity queue client", () => {
    // Given
    vi.stubEnv("BLOB_STORAGE_ACCOUNT_NAME", "stbccwebstagingdata");
    vi.stubEnv("RUNTIME_STORAGE_ACCOUNT_NAME", "stbccwebstagingrt");
    vi.stubEnv("STORAGE_UMI_CLIENT_ID", "00000000-0000-0000-0000-000000000001");

    // When
    const client = getRuntimeQueueClient("rescore-jobs");

    // Then
    expect(client.url).toBe(
      "https://stbccwebstagingrt.queue.core.windows.net/rescore-jobs",
    );
  });

  test("does not fall back to the runtime account for blob storage", () => {
    // Given
    vi.stubEnv("RUNTIME_STORAGE_ACCOUNT_NAME", "stbccwebstagingrt");
    vi.stubEnv("STORAGE_UMI_CLIENT_ID", "00000000-0000-0000-0000-000000000001");

    // When / Then
    expect(() => getBlobServiceClient()).toThrow(
      new StorageConfigError("BLOB_STORAGE_ACCOUNT_NAME"),
    );
  });

  test("does not fall back to the data account for runtime queues", () => {
    // Given
    vi.stubEnv("BLOB_STORAGE_ACCOUNT_NAME", "stbccwebstagingdata");
    vi.stubEnv("STORAGE_UMI_CLIENT_ID", "00000000-0000-0000-0000-000000000001");

    // When / Then
    expect(() => getRuntimeQueueClient("rescore-jobs")).toThrow(
      new StorageConfigError("RUNTIME_STORAGE_ACCOUNT_NAME"),
    );
  });

  test.each([
    ["blob account only", "BLOB_STORAGE_ACCOUNT_NAME", "STORAGE_UMI_CLIENT_ID"],
    ["blob client id only", "STORAGE_UMI_CLIENT_ID", "BLOB_STORAGE_ACCOUNT_NAME"],
  ])("rejects partial blob identity config: %s", (_case, configured, missing) => {
    // Given
    vi.stubEnv(configured, "configured");

    // When / Then
    expect(() => getBlobServiceClient()).toThrow(
      new StorageConfigError(missing),
    );
  });

  test.each([
    ["runtime account only", "RUNTIME_STORAGE_ACCOUNT_NAME", "STORAGE_UMI_CLIENT_ID"],
    ["runtime client id only", "STORAGE_UMI_CLIENT_ID", "RUNTIME_STORAGE_ACCOUNT_NAME"],
  ])("rejects partial queue identity config: %s", (_case, configured, missing) => {
    // Given
    vi.stubEnv(configured, "configured");

    // When / Then
    expect(() => getRuntimeQueueClient("rescore-jobs")).toThrow(
      new StorageConfigError(missing),
    );
  });

  test("re-reads blob environment after reset", () => {
    // Given
    vi.stubEnv("BLOB_STORAGE_ACCOUNT_NAME", "firstdata");
    vi.stubEnv("STORAGE_UMI_CLIENT_ID", "00000000-0000-0000-0000-000000000001");
    const first = getBlobServiceClient();
    vi.stubEnv("BLOB_STORAGE_ACCOUNT_NAME", "seconddata");

    // When
    const cached = getBlobServiceClient();
    resetStorageClientSingletons();
    const refreshed = getBlobServiceClient();

    // Then
    expect(cached).toBe(first);
    expect(refreshed).not.toBe(first);
    expect(refreshed.url).toBe("https://seconddata.blob.core.windows.net/");
  });

  test("re-reads queue environment after reset", () => {
    // Given
    vi.stubEnv("RUNTIME_STORAGE_ACCOUNT_NAME", "firstruntime");
    vi.stubEnv("STORAGE_UMI_CLIENT_ID", "00000000-0000-0000-0000-000000000001");
    const first = getRuntimeQueueClient("rescore-jobs");
    vi.stubEnv("RUNTIME_STORAGE_ACCOUNT_NAME", "secondruntime");

    // When
    const cached = getRuntimeQueueClient("rescore-jobs");
    resetStorageClientSingletons();
    const refreshed = getRuntimeQueueClient("rescore-jobs");

    // Then
    expect(cached).toBe(first);
    expect(refreshed).not.toBe(first);
    expect(refreshed.url).toBe(
      "https://secondruntime.queue.core.windows.net/rescore-jobs",
    );
  });
});
