// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  BlobClientConfigurationError,
  blobServiceUrl,
  createBlobServiceClient,
} from "../blobClient.mjs";

const AZURITE_CONNECTION_STRING =
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;" +
  "AccountKey=not-a-real-secret;" +
  "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";
const ORIGINAL_CONNECTION_STRING = process.env.BLOB_CONNECTION_STRING;
const ORIGINAL_ACCOUNT_NAME = process.env.BLOB_STORAGE_ACCOUNT_NAME;

function restoreEnvironment(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

describe("createBlobServiceClient", () => {
  beforeEach(() => {
    delete process.env.BLOB_CONNECTION_STRING;
    delete process.env.BLOB_STORAGE_ACCOUNT_NAME;
  });

  afterEach(() => {
    restoreEnvironment("BLOB_CONNECTION_STRING", ORIGINAL_CONNECTION_STRING);
    restoreEnvironment("BLOB_STORAGE_ACCOUNT_NAME", ORIGINAL_ACCOUNT_NAME);
  });

  test("returns an Azurite client when a connection string is configured", () => {
    // Given
    process.env.BLOB_CONNECTION_STRING = AZURITE_CONNECTION_STRING;
    process.env.BLOB_STORAGE_ACCOUNT_NAME = "ignoredaccount";

    // When
    const client = createBlobServiceClient();

    // Then
    assert.equal(client.url, "http://127.0.0.1:10000/devstoreaccount1");
  });

  test("returns the account HTTPS endpoint when only an account name is configured", () => {
    // Given
    process.env.BLOB_STORAGE_ACCOUNT_NAME = "stbccwebstagingdata";

    // When
    const client = createBlobServiceClient();

    // Then
    assert.equal(
      blobServiceUrl("stbccwebstagingdata"),
      "https://stbccwebstagingdata.blob.core.windows.net",
    );
    assert.equal(client.url, "https://stbccwebstagingdata.blob.core.windows.net/");
  });

  test("throws a configuration error before I/O when neither setting is configured", () => {
    // Given
    const constructClient = () => createBlobServiceClient();

    // When / Then
    assert.throws(
      constructClient,
      (error) =>
        error instanceof BlobClientConfigurationError &&
        error.message ===
          "Blob storage requires BLOB_CONNECTION_STRING or BLOB_STORAGE_ACCOUNT_NAME",
    );
  });

  test("does not write connection-string secrets to diagnostics", () => {
    // Given
    process.env.BLOB_CONNECTION_STRING = AZURITE_CONNECTION_STRING;
    const diagnostics = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...values) => diagnostics.push(values.join(" "));
    console.error = (...values) => diagnostics.push(values.join(" "));

    // When
    try {
      createBlobServiceClient();
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    // Then
    const output = diagnostics.join("\n");
    assert.equal(output, "");
    assert.doesNotMatch(output, /not-a-real-secret|AccountKey=/);
  });
});
