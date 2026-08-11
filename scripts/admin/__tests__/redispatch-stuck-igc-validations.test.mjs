#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * redispatch-stuck-igc-validations.test.mjs — `node --test`, real Azurite blobs.
 *
 * Each storage test provisions its own private container. Queue writes use a
 * narrow in-memory client so the suite can assert the exact producer payload
 * without consuming messages from the shared Azurite validation queue.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after } from "node:test";

import { BlobServiceClient } from "@azure/storage-blob";

import {
  collectCandidates,
  main,
  parseArgs,
  pendingJobs,
  queueConnectionString,
  resultPath,
} from "../redispatch-stuck-igc-validations.mjs";

const AZURITE_DEV_CS =
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;" +
  "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;" +
  "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";
const FUTURE_CUTOFF_MS = 3 * 60 * 60 * 1000;
const service = BlobServiceClient.fromConnectionString(AZURITE_DEV_CS);
const createdContainers = new Set();

function job(overrides = {}) {
  return {
    roundId: "round-1",
    teamId: "team-1",
    place: 1,
    flightId: "flight-1",
    validationAttemptId: "attempt-1",
    ...overrides,
  };
}

function roundWithFlights(flights) {
  return {
    teams: [
      {
        id: "team-1",
        pilots: flights.map((flight, index) => ({
          placeInTeam: index + 1,
          flight,
        })),
      },
    ],
  };
}

function pendingFlight(overrides = {}) {
  return {
    id: "flight-1",
    isManualLog: false,
    igcPath: "flight-igcs/flight-1.igc",
    validation: {
      signature: "pending",
      validationAttemptId: "attempt-1",
    },
    ...overrides,
  };
}

async function freshContainer() {
  const name = `test-igc-redispatch-${randomBytes(6).toString("hex")}`;
  const container = service.getContainerClient(name);
  await container.create();
  createdContainers.add(name);
  return container;
}

async function seedJson(container, path, value) {
  const text = JSON.stringify(value);
  await container.getBlockBlobClient(path).upload(text, Buffer.byteLength(text), {
    blobHTTPHeaders: { blobContentType: "application/json" },
  });
}

after(async () => {
  for (const name of createdContainers) {
    await service.getContainerClient(name).deleteIfExists().catch(() => {});
  }
});

test("dry-run is the default and lists eligible jobs without opening a queue", async () => {
  // Given
  const container = await freshContainer();
  const expectedJob = job();
  await seedJson(container, "rounds/round-1.json", roundWithFlights([pendingFlight()]));
  const lines = [];
  let queueFactoryCalls = 0;

  // When
  await main({
    argv: [],
    container,
    now: Date.now() + FUTURE_CUTOFF_MS,
    queueFactory: () => {
      queueFactoryCalls += 1;
      throw new Error("dry-run must not create a queue client");
    },
    log: (line) => lines.push(line),
  });

  // Then
  assert.deepEqual(parseArgs([]), { help: false, mode: "dry-run", olderThanHours: 2 });
  assert.equal(queueFactoryCalls, 0);
  assert.ok(lines.includes(`[DRY-RUN] roundId=${expectedJob.roundId} teamId=${expectedJob.teamId} place=${expectedJob.place} flightId=${expectedJob.flightId} validationAttemptId=${expectedJob.validationAttemptId}`));
  assert.ok(lines.includes("Redispatched: 0"));
});

test("age cutoff protects newer pending rounds and admits older rounds", async () => {
  // Given
  const container = await freshContainer();
  await seedJson(container, "rounds/round-1.json", roundWithFlights([pendingFlight()]));
  const properties = await container.getBlobClient("rounds/round-1.json").getProperties();
  const modifiedAt = properties.lastModified.getTime();

  // When
  const newer = await collectCandidates(container, modifiedAt - 1);
  const older = await collectCandidates(container, modifiedAt + 1);

  // Then
  assert.equal(newer.candidates.length, 0);
  assert.equal(newer.summary.recent, 1);
  assert.deepEqual(older.candidates.map((candidate) => candidate.job), [job()]);
  assert.equal(older.summary.recent, 0);
});

test("durable validation results prevent redispatch", async () => {
  // Given
  const container = await freshContainer();
  await seedJson(container, "rounds/round-1.json", roundWithFlights([pendingFlight()]));
  await seedJson(container, resultPath("attempt-1"), { status: "complete" });

  // When
  const collected = await collectCandidates(container, Date.now() + FUTURE_CUTOFF_MS);

  // Then
  assert.equal(collected.candidates.length, 0);
  assert.equal(collected.summary.results, 1);
});

test("only pending non-manual flights become jobs", () => {
  // Given
  const round = roundWithFlights([
    pendingFlight(),
    pendingFlight({ id: "manual", isManualLog: true }),
    pendingFlight({ id: "valid", validation: { signature: "valid" } }),
    pendingFlight({ id: "invalid", validation: { signature: "invalid" } }),
  ]);

  // When
  const jobs = pendingJobs(round, "round-1", "rounds/round-1.json");

  // Then
  assert.deepEqual(jobs, [job()]);
});

test("pre-send recheck protects a candidate whose committed job changed", async () => {
  // Given
  const container = await freshContainer();
  await seedJson(container, "rounds/round-1.json", roundWithFlights([pendingFlight()]));
  const sentMessages = [];
  const lines = [];

  // When
  await main({
    argv: ["--redispatch"],
    container,
    now: Date.now() + FUTURE_CUTOFF_MS,
    queueFactory: () => ({
      createIfNotExists: async () => {
        await seedJson(container, "rounds/round-1.json", roundWithFlights([
          pendingFlight({ validation: { signature: "pending", validationAttemptId: "attempt-2" } }),
        ]));
      },
      sendMessage: async (message) => {
        sentMessages.push(message);
      },
    }),
    log: (line) => lines.push(line),
  });

  // Then
  assert.deepEqual(sentMessages, []);
  assert.ok(lines.includes("Changed before redispatch and protected: 1"));
  assert.ok(lines.includes("Redispatched: 0"));
});

test("remote redispatch fails closed without AzureWebJobsStorage", () => {
  // Given
  const previousQueue = process.env.AzureWebJobsStorage;
  const previousBlob = process.env.BLOB_CONNECTION_STRING;
  delete process.env.AzureWebJobsStorage;
  process.env.BLOB_CONNECTION_STRING = "DefaultEndpointsProtocol=https;AccountName=remote";

  try {
    // When / Then
    assert.throws(
      () => queueConnectionString(),
      /AzureWebJobsStorage or RUNTIME_STORAGE_ACCOUNT_NAME is required when redispatching to a remote target/
    );
  } finally {
    if (previousQueue === undefined) delete process.env.AzureWebJobsStorage;
    else process.env.AzureWebJobsStorage = previousQueue;
    if (previousBlob === undefined) delete process.env.BLOB_CONNECTION_STRING;
    else process.env.BLOB_CONNECTION_STRING = previousBlob;
  }
});

test("redispatch sends the exact base64-encoded IGC validation job", async () => {
  // Given
  const container = await freshContainer();
  const expectedJob = job();
  await seedJson(container, "rounds/round-1.json", roundWithFlights([pendingFlight()]));
  const sentMessages = [];
  let queueCreated = false;

  // When
  await main({
    argv: ["--redispatch"],
    container,
    now: Date.now() + FUTURE_CUTOFF_MS,
    queueFactory: () => ({
      createIfNotExists: async () => {
        queueCreated = true;
      },
      sendMessage: async (message) => {
        sentMessages.push(message);
      },
    }),
    log: () => {},
  });

  // Then
  const exactPayload = Buffer.from(JSON.stringify(expectedJob), "utf8").toString("base64");
  assert.equal(queueCreated, true);
  assert.deepEqual(sentMessages, [exactPayload]);
  assert.deepEqual(JSON.parse(Buffer.from(sentMessages[0], "base64").toString("utf8")), expectedJob);
});
