// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  blobStorageIdentity,
  createBlobServiceClient,
  createQueueClient,
  createQueueServiceClient,
  preflightBlobReadAccess,
  preflightQueueReadAccess,
  queueStorageIdentity,
  StorageConfigurationError,
} from "../lib/storageClients.mjs";
import { loadTestTargetIdentity } from "../lib/loadTestTargetIdentity.mjs";

const BLOB_CONNECTION =
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=blob-secret;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";
const QUEUE_CONNECTION =
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=queue-secret;QueueEndpoint=http://127.0.0.1:10001/devstoreaccount1;";

const fakeCredential = { getToken: async () => ({ token: "test-token", expiresOnTimestamp: 1 }) };

test("blob factory prefers an explicit connection string over account-name mode", () => {
  // Given
  const environment = {
    BLOB_CONNECTION_STRING: BLOB_CONNECTION,
    BLOB_STORAGE_ACCOUNT_NAME: "ignoreddata",
  };

  // When
  const client = createBlobServiceClient({ environment, credential: fakeCredential });

  // Then
  assert.equal(client.url, "http://127.0.0.1:10000/devstoreaccount1");
});

test("account-name mode constructs separate blob and queue URLs with one credential", () => {
  // Given
  const environment = {
    BLOB_STORAGE_ACCOUNT_NAME: "bccdata",
    RUNTIME_STORAGE_ACCOUNT_NAME: "bccruntime",
  };

  // When
  const blob = createBlobServiceClient({ environment, credential: fakeCredential });
  const queue = createQueueClient("igc-validation", { environment, credential: fakeCredential });

  // Then
  assert.equal(blob.url, "https://bccdata.blob.core.windows.net/");
  assert.equal(queue.url, "https://bccruntime.queue.core.windows.net/igc-validation");
  assert.equal(blob.credential, fakeCredential);
  assert.equal(queue.credential, fakeCredential);
});

test("queue factory prefers AzureWebJobsStorage over runtime account-name mode", () => {
  // Given
  const environment = {
    AzureWebJobsStorage: QUEUE_CONNECTION,
    RUNTIME_STORAGE_ACCOUNT_NAME: "ignoredruntime",
  };

  // When
  const client = createQueueClient("igc-validation", { environment, credential: fakeCredential });

  // Then
  assert.equal(client.url, "http://127.0.0.1:10001/devstoreaccount1/igc-validation");
});

test("queue service factory supports connection-string and runtime account-name modes", () => {
  // Given
  const connectionEnvironment = {
    AzureWebJobsStorage: QUEUE_CONNECTION,
    RUNTIME_STORAGE_ACCOUNT_NAME: "ignoredruntime",
  };
  const accountEnvironment = { RUNTIME_STORAGE_ACCOUNT_NAME: "bccruntime" };

  // When
  const connectionClient = createQueueServiceClient({
    environment: connectionEnvironment,
    credential: fakeCredential,
  });
  const identityClient = createQueueServiceClient({
    environment: accountEnvironment,
    credential: fakeCredential,
  });

  // Then
  assert.equal(connectionClient.url, "http://127.0.0.1:10001/devstoreaccount1");
  assert.equal(identityClient.url, "https://bccruntime.queue.core.windows.net");
  assert.equal(identityClient.credential, fakeCredential);
});

test("factories fail before I/O when their account configuration is absent", () => {
  // Given
  const environment = {};

  // When / Then
  assert.throws(
    () => createBlobServiceClient({ environment, credential: fakeCredential }),
    /BLOB_CONNECTION_STRING or BLOB_STORAGE_ACCOUNT_NAME is required/,
  );
  assert.throws(
    () => createQueueClient("igc-validation", { environment, credential: fakeCredential }),
    /AzureWebJobsStorage or RUNTIME_STORAGE_ACCOUNT_NAME is required/,
  );
});

test("account-name read preflights name the required data-plane roles", async () => {
  // Given
  const forbidden = Object.assign(new Error("authorization denied"), { statusCode: 403 });

  // When / Then
  await assert.rejects(
    () => preflightBlobReadAccess({
      environment: { BLOB_STORAGE_ACCOUNT_NAME: "bccdata" },
      container: { listBlobsFlat: () => ({
        [Symbol.asyncIterator]() {
          return { next: async () => { throw forbidden; } };
        },
      }) },
    }),
    /Storage Blob Data Reader.*Storage Blob Data Contributor/,
  );
  await assert.rejects(
    () => preflightQueueReadAccess({
      environment: { RUNTIME_STORAGE_ACCOUNT_NAME: "bccruntime" },
      queue: { getProperties: async () => { throw forbidden; } },
    }),
    /Storage Queue Data Reader.*Storage Queue Data Contributor/,
  );
});

test("read preflights preserve non-authorization failures", async () => {
  // Given
  const unavailable = Object.assign(new Error("service unavailable"), { statusCode: 503 });

  // When / Then
  await assert.rejects(
    () => preflightQueueReadAccess({
      environment: { RUNTIME_STORAGE_ACCOUNT_NAME: "bccruntime" },
      queue: { getProperties: async () => { throw unavailable; } },
    }),
    (error) => error === unavailable,
  );
});

test("canonical storage identity strips credentials from an explicit endpoint", () => {
  // Given
  const connectionString =
    "DefaultEndpointsProtocol=https;AccountName=bccdata;SharedAccessSignature=sig=secret;" +
    "BlobEndpoint=https://bccdata.blob.core.windows.net/?sig=secret;";

  // When
  const identity = blobStorageIdentity({ connectionString });

  // Then
  assert.deepEqual(identity, {
    accountName: "bccdata",
    endpoint: "https://bccdata.blob.core.windows.net",
  });
});

test("blob storage identity accepts an account-less service SAS without exposing its secret", () => {
  // Given
  const connectionString =
    "BlobEndpoint=https://bccdata.blob.core.windows.net/?sv=2026-01-01&sig=blob-secret#fragment;" +
    "SharedAccessSignature=sv=2026-01-01&sig=blob-secret;";

  // When
  const identity = blobStorageIdentity({ connectionString });

  // Then
  assert.equal(identity.accountName, null);
  assert.equal(identity.endpoint, "https://bccdata.blob.core.windows.net");
  assert.doesNotMatch(identity.endpoint, /blob-secret|sig=|sv=/);
});

test("queue storage identity accepts an account-less service SAS without exposing its secret", () => {
  // Given
  const connectionString =
    "QueueEndpoint=https://bccruntime.queue.core.windows.net/?sv=2026-01-01&sig=queue-secret#fragment;" +
    "SharedAccessSignature=sv=2026-01-01&sig=queue-secret;";

  // When
  const identity = queueStorageIdentity({ connectionString });

  // Then
  assert.equal(identity.accountName, null);
  assert.equal(identity.endpoint, "https://bccruntime.queue.core.windows.net");
  assert.doesNotMatch(identity.endpoint, /queue-secret|sig=|sv=/);
});

test("storage identity still requires AccountName without an explicit endpoint", () => {
  // Given
  const connectionString = "SharedAccessSignature=sv=2026-01-01&sig=secret;";

  // When / Then
  assert.throws(
    () => blobStorageIdentity({ connectionString }),
    (error) => error instanceof StorageConfigurationError &&
      error.message === "Storage connection string is missing AccountName",
  );
});

test("target digest is stable across equivalent connection-string and account-name representations", () => {
  // Given
  const connectionEnvironment = {
    BLOB_CONNECTION_STRING:
      "DefaultEndpointsProtocol=https;AccountName=bccdata;AccountKey=blob-secret;EndpointSuffix=core.windows.net;",
    AzureWebJobsStorage:
      "DefaultEndpointsProtocol=https;AccountName=bccruntime;AccountKey=queue-secret;EndpointSuffix=core.windows.net;",
  };
  const accountEnvironment = {
    BLOB_STORAGE_ACCOUNT_NAME: "bccdata",
    RUNTIME_STORAGE_ACCOUNT_NAME: "bccruntime",
  };

  // When
  const fromConnections = loadTestTargetIdentity("https://api.example.test/path", connectionEnvironment);
  const fromAccounts = loadTestTargetIdentity("https://api.example.test/other", accountEnvironment);

  // Then
  assert.equal(fromConnections, fromAccounts);
  assert.doesNotMatch(fromConnections, /blob-secret|queue-secret/);
});

test("target digest changes when either storage account changes", () => {
  // Given
  const environment = {
    BLOB_STORAGE_ACCOUNT_NAME: "bccdata",
    RUNTIME_STORAGE_ACCOUNT_NAME: "bccruntime",
  };

  // When
  const baseline = loadTestTargetIdentity("https://api.example.test", environment);
  const dataChanged = loadTestTargetIdentity("https://api.example.test", {
    ...environment,
    BLOB_STORAGE_ACCOUNT_NAME: "bccdata2",
  });
  const runtimeChanged = loadTestTargetIdentity("https://api.example.test", {
    ...environment,
    RUNTIME_STORAGE_ACCOUNT_NAME: "bccruntime2",
  });

  // Then
  assert.notEqual(dataChanged, baseline);
  assert.notEqual(runtimeChanged, baseline);
});

test("target digest accepts the Azurite development-storage shorthand", () => {
  // Given
  const shorthand = {
    BLOB_CONNECTION_STRING: "UseDevelopmentStorage=true",
    AzureWebJobsStorage: "UseDevelopmentStorage=true",
  };
  const explicit = {
    BLOB_CONNECTION_STRING: BLOB_CONNECTION,
    AzureWebJobsStorage: QUEUE_CONNECTION,
  };

  // When
  const shorthandDigest = loadTestTargetIdentity("http://127.0.0.1:7071", shorthand);
  const explicitDigest = loadTestTargetIdentity("http://127.0.0.1:7071", explicit);

  // Then
  assert.equal(shorthandDigest, explicitDigest);
});

test("fixture seeding preflights account-mode reads before creating containers", async () => {
  // Given
  const source = await readFile(new URL("../seed-fixtures.mjs", import.meta.url), "utf8");

  // When
  const preflightAt = source.indexOf("preflightBlobContainerRead(publicContainer)");
  const createAt = source.indexOf("publicContainer.createIfNotExists");

  // Then
  assert.ok(preflightAt >= 0);
  assert.ok(createAt > preflightAt);
});
