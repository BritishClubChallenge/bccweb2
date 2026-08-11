// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * Redispatch IGC validations stranded by a crash between round commit and queue send.
 * Dry-run is the default; --redispatch reuses the committed validation attempt ID.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getPrivateContainer, readJson } from "../lib/blobSeed.mjs";
import {
  createQueueClient,
  preflightQueueReadAccess,
} from "../lib/storageClients.mjs";

const QUEUE_NAME = "igc-validation";
const ROUND_PREFIX = "rounds/";
const RESULT_PREFIX = "igc-validation/results/";
const DEFAULT_OLDER_THAN_HOURS = 2;
const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;
const LOCAL_AZURITE_QUEUE_CONNECTION =
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;QueueEndpoint=http://127.0.0.1:10001/devstoreaccount1;TableEndpoint=http://127.0.0.1:10002/devstoreaccount1;";

function printHelp(log = console.log) {
  log(`Usage: node scripts/admin/redispatch-stuck-igc-validations.mjs [options]

Find old, non-manual flights still pending IGC validation with no durable result.
The default is dry-run. Redispatch reuses each flight's existing attempt ID.

Options:
  --dry-run                  List eligible validations without enqueueing (default)
  --redispatch               Enqueue eligible validations on igc-validation
  --older-than-hours <hours> Minimum pending round age in hours (default: 2)
  --help                     Show this help`);
}

export function parseArgs(argv) {
  let mode = "dry-run";
  let olderThanHours = DEFAULT_OLDER_THAN_HOURS;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    if (argument === "--dry-run") {
      mode = "dry-run";
      continue;
    }
    if (argument === "--redispatch") {
      mode = "redispatch";
      continue;
    }
    if (argument === "--older-than-hours") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--older-than-hours requires a positive number");
      }
      olderThanHours = Number(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  if (!Number.isFinite(olderThanHours) || olderThanHours <= 0) {
    throw new Error("--older-than-hours must be a positive number");
  }

  return { help: false, mode, olderThanHours };
}

export function queueConnectionString() {
  const configured = process.env.AzureWebJobsStorage;
  if (typeof configured === "string" && configured.length > 0) return configured;
  if (typeof process.env.RUNTIME_STORAGE_ACCOUNT_NAME === "string" &&
    process.env.RUNTIME_STORAGE_ACCOUNT_NAME.length > 0) return undefined;

  const blobConnection = process.env.BLOB_CONNECTION_STRING;
  if (
    blobConnection === undefined ||
    blobConnection.includes("localhost") ||
    blobConnection.includes("127.0.0.1")
  ) {
    return LOCAL_AZURITE_QUEUE_CONNECTION;
  }
  throw new Error(
    "AzureWebJobsStorage or RUNTIME_STORAGE_ACCOUNT_NAME is required when redispatching to a remote target",
  );
}

function roundFileName(blobName) {
  const name = blobName.slice(ROUND_PREFIX.length);
  return name.endsWith(".json") && !name.includes("/") ? name : null;
}

function assertRoundShape(round, path) {
  if (!round || typeof round !== "object" || !Array.isArray(round.teams)) {
    throw new Error(`Invalid authoritative round blob: ${path}`);
  }
  for (const team of round.teams) {
    if (!team || typeof team.id !== "string" || !Array.isArray(team.pilots)) {
      throw new Error(`Invalid authoritative round blob: ${path}`);
    }
  }
}

export function pendingJobs(round, roundId, path) {
  const jobs = [];
  for (const team of round.teams) {
    for (const pilot of team.pilots) {
      if (!pilot || typeof pilot !== "object") {
        throw new Error(`Invalid authoritative round blob: ${path}`);
      }
      const flight = pilot.flight;
      if (flight === null || flight === undefined) continue;
      if (typeof flight !== "object") {
        throw new Error(`Invalid authoritative round blob: ${path}`);
      }
      const validation = flight.validation;
      if (!validation || validation.signature !== "pending") continue;
      if (
        flight.isManualLog !== false ||
        typeof flight.igcPath !== "string" || flight.igcPath.length === 0 ||
        typeof validation.validationAttemptId !== "string" ||
        validation.validationAttemptId.length === 0
      ) {
        continue;
      }
      if (
        !Number.isInteger(pilot.placeInTeam) ||
        typeof flight.id !== "string" || flight.id.length === 0
      ) {
        throw new Error(`Invalid pending validation in authoritative round blob: ${path}`);
      }
      jobs.push({
        roundId,
        teamId: team.id,
        place: pilot.placeInTeam,
        flightId: flight.id,
        validationAttemptId: validation.validationAttemptId,
      });
    }
  }
  return jobs;
}

export function resultPath(attemptId) {
  return `${RESULT_PREFIX}${attemptId}.json`;
}

export async function hasDurableResult(container, attemptId) {
  return container.getBlobClient(resultPath(attemptId)).exists();
}

export async function collectCandidates(container, cutoff) {
  const candidates = [];
  const summary = { roundsScanned: 0, pendingScanned: 0, recent: 0, results: 0 };

  for await (const blob of container.listBlobsFlat({ prefix: ROUND_PREFIX })) {
    const fileName = roundFileName(blob.name);
    if (fileName === null) continue;
    summary.roundsScanned += 1;
    const round = await readJson(container, blob.name);
    assertRoundShape(round, blob.name);
    const jobs = pendingJobs(round, fileName.slice(0, -5), blob.name);
    summary.pendingScanned += jobs.length;
    if (!blob.properties.lastModified || blob.properties.lastModified.getTime() >= cutoff) {
      summary.recent += jobs.length;
      continue;
    }
    for (const job of jobs) {
      if (await hasDurableResult(container, job.validationAttemptId)) {
        summary.results += 1;
      } else {
        candidates.push({ path: blob.name, job });
      }
    }
  }
  return { candidates, summary };
}

export function sameJob(left, right) {
  return left.roundId === right.roundId && left.teamId === right.teamId &&
    left.place === right.place && left.flightId === right.flightId &&
    left.validationAttemptId === right.validationAttemptId;
}

export async function remainsEligible(container, candidate, cutoff) {
  const blob = container.getBlobClient(candidate.path);
  const properties = await blob.getProperties();
  if (!properties.lastModified || properties.lastModified.getTime() >= cutoff) return false;
  const round = await readJson(container, candidate.path);
  assertRoundShape(round, candidate.path);
  const current = pendingJobs(round, candidate.job.roundId, candidate.path);
  if (!current.some((job) => sameJob(job, candidate.job))) return false;
  return !(await hasDurableResult(container, candidate.job.validationAttemptId));
}

function describe(job) {
  return `roundId=${job.roundId} teamId=${job.teamId} place=${job.place} ` +
    `flightId=${job.flightId} validationAttemptId=${job.validationAttemptId}`;
}

export async function main({
  argv = process.argv.slice(2),
  container,
  now = Date.now(),
  queueFactory = (connectionString, queueName) => (
    createQueueClient(queueName, { connectionString })
  ),
  log = console.log,
} = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp(log);
    return;
  }

  const storageContainer = container ?? getPrivateContainer();
  const cutoff = now - options.olderThanHours * MILLISECONDS_PER_HOUR;
  const { candidates, summary } = await collectCandidates(storageContainer, cutoff);
  let redispatched = 0;
  let changed = 0;
  let queue;

  if (options.mode === "redispatch" && candidates.length > 0) {
    const connectionString = queueConnectionString();
    queue = queueFactory(connectionString, QUEUE_NAME);
    await preflightQueueReadAccess({ queue, connectionString });
    await queue.createIfNotExists();
  }

  for (const candidate of candidates) {
    if (options.mode === "dry-run") {
      log(`[DRY-RUN] ${describe(candidate.job)}`);
      continue;
    }
    if (!(await remainsEligible(storageContainer, candidate, cutoff))) {
      changed += 1;
      continue;
    }
    const message = Buffer.from(JSON.stringify(candidate.job), "utf8").toString("base64");
    await queue.sendMessage(message);
    redispatched += 1;
    log(`[REDISPATCH] ${describe(candidate.job)}`);
  }

  log("");
  log(`Mode: ${options.mode}`);
  log(`Safety threshold: ${options.olderThanHours} hours`);
  log(`Authoritative rounds scanned: ${summary.roundsScanned}`);
  log(`Pending validations scanned: ${summary.pendingScanned}`);
  log(`Recent pending validations protected: ${summary.recent}`);
  log(`Pending validations with durable results skipped: ${summary.results}`);
  log(`Eligible pending validations: ${candidates.length - changed}`);
  log(`Changed before redispatch and protected: ${changed}`);
  log(`Redispatched: ${redispatched}`);
}

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
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[ERROR] IGC validation redispatch failed: ${message}`);
    process.exitCode = 1;
  });
}
