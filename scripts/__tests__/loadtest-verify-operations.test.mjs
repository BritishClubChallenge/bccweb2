// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createReflectQueueReader } from "../lib/loadTestReflectQueues.mjs";
import { replayPersistedSignature } from "../lib/loadTestSignReplay.mjs";
import { parseVerificationArtifacts } from "../lib/loadTestSignVerificationArtifacts.mjs";
import { artifactFixture, preparedFixture, signaturesFixture } from "./helpers/signVerifyFixtures.mjs";

test("queue reader constructs both clients only from AzureWebJobsStorage", async () => {
  // Given
  const secret = "opaque-queue-secret";
  const creations = [];
  const propertyCalls = [];
  const readCounts = createReflectQueueReader({
    environment: { AzureWebJobsStorage: secret, BLOB_CONNECTION_STRING: "wrong-secret" },
    queueClientFactory: (connectionString, queueName) => {
      creations.push({ connectionString, queueName });
      return { getProperties: async (options) => {
        propertyCalls.push({ queueName, options });
        return { approximateMessagesCount: 0 };
      } };
    },
    abortSignalFactory: (timeoutMs) => ({ timeoutMs }),
  });

  // When
  const counts = await readCounts();

  // Then
  assert.deepEqual(creations, [
    { connectionString: secret, queueName: "signtofly-reflect" },
    { connectionString: secret, queueName: "signtofly-reflect-poison" },
  ]);
  assert.deepEqual(counts, { main: 0, poison: 0 });
  assert.deepEqual(propertyCalls.map(({ options }) => options), [
    { abortSignal: { timeoutMs: 15_000 } }, { abortSignal: { timeoutMs: 15_000 } },
  ]);
});

test("queue reader sanitizes SDK timeout without exposing the connection string", async () => {
  // Given
  const secret = "opaque-queue-secret";
  const readCounts = createReflectQueueReader({
    environment: { AzureWebJobsStorage: secret },
    queueClientFactory: () => ({ getProperties: async () => { throw new Error(secret); } }),
  });

  // When / Then
  await assert.rejects(readCounts, (error) => {
    assert.match(error.message, /properties request failed.*state preserved/);
    assert.doesNotMatch(error.message, /opaque-queue-secret/);
    return true;
  });
});

test("queue reader does not fall back to BLOB_CONNECTION_STRING", () => {
  // Given / When / Then
  assert.throws(
    () => createReflectQueueReader({
      baseUrl: "https://bcc-loadtest.example.test",
      environment: { BLOB_CONNECTION_STRING: "wrong-secret" },
    }),
    /AzureWebJobsStorage or RUNTIME_STORAGE_ACCOUNT_NAME is required/,
  );
});

test("queue reader uses the queue-capable Azurite default only for loopback", () => {
  // Given
  const connections = [];
  const factory = (connectionString) => {
    connections.push(connectionString);
    return { getProperties: async () => ({ approximateMessagesCount: 0 }) };
  };

  // When
  createReflectQueueReader({
    baseUrl: "http://127.0.0.1:7071",
    environment: { BLOB_CONNECTION_STRING: "wrong-secret" },
    queueClientFactory: factory,
  });

  // Then
  assert.equal(connections.length, 2);
  assert.ok(connections.every((value) => value.includes("QueueEndpoint=http://127.0.0.1:10001/devstoreaccount1")));
  assert.ok(connections.every((value) => !value.includes("wrong-secret")));
  assert.throws(
    () => createReflectQueueReader({
      baseUrl: "https://bcc-loadtest.example.test",
      environment: {},
      queueClientFactory: factory,
    }),
    /AzureWebJobsStorage or RUNTIME_STORAGE_ACCOUNT_NAME is required/,
  );
});

test("replay posts exactly once when response ID is wrong", async () => {
  // Given
  const prepared = preparedFixture();
  const artifact = artifactFixture(prepared);
  const parsed = parseVerificationArtifacts(prepared, artifact.events, artifact.summary);
  const signatures = signaturesFixture(parsed);
  let posts = 0;

  // When / Then
  await assert.rejects(() => replayPersistedSignature({
    parsed, signatures, prepared, login: async () => "token",
    post: async () => { posts += 1; return { status: 200, id: "wrong" }; },
  }), /team-0:1.*wrong.*signature-0/);
  assert.equal(posts, 1);
});

test("verifier sources never consume queues or reference blob credentials", async () => {
  // Given
  const sources = await Promise.all([
    readFile(new URL("../lib/loadTestReflectQueues.mjs", import.meta.url), "utf8"),
    readFile(new URL("../verify-loadtest-signtofly.mjs", import.meta.url), "utf8"),
  ]);
  const source = sources.join("\n");

  // When / Then
  assert.doesNotMatch(source, /peekMessages|receiveMessages|deleteMessage|clearMessages/);
  assert.doesNotMatch(source, /BLOB_CONNECTION_STRING/);
  assert.doesNotMatch(source, /cleanup-loadtest|cleanupLoadRound|unlinkSync|rmSync/);
  assert.match(source, /AzureWebJobsStorage/);
  assert.match(source, /getProperties/);
  assert.match(source, /encodeURIComponent\(roundId\)/);
  assert.match(source, /encodeURIComponent\(target\.teamId\)/);
});
