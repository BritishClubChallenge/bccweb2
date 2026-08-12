// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import {
  createQueueClient,
  preflightQueueReadAccess,
  StorageRbacError,
} from "./storageClients.mjs";

const MAIN_QUEUE = "signtofly-reflect";
const POISON_QUEUE = "signtofly-reflect-poison";
export const LOCAL_AZURITE_QUEUE_CONNECTION =
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;QueueEndpoint=http://127.0.0.1:10001/devstoreaccount1;TableEndpoint=http://127.0.0.1:10002/devstoreaccount1;";

export function resolveReflectQueueConnection(baseUrl, environment = process.env) {
  const configured = environment.AzureWebJobsStorage;
  if (typeof configured === "string" && configured.length > 0) return configured;
  if (typeof environment.RUNTIME_STORAGE_ACCOUNT_NAME === "string" &&
    environment.RUNTIME_STORAGE_ACCOUNT_NAME.length > 0) return undefined;
  const host = new URL(baseUrl).hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return LOCAL_AZURITE_QUEUE_CONNECTION;
  }
  fail("AzureWebJobsStorage or RUNTIME_STORAGE_ACCOUNT_NAME is required for reflect queue verification");
}

function fail(message) {
  throw new Error(`[verify-loadtest-signtofly] ${message}`);
}

export function createReflectQueueReader(options) {
  const { baseUrl = process.env.BCC_API_BASE_URL ?? "http://localhost:7071",
    environment = process.env, queueClientFactory = (connectionString, name) => (
      createQueueClient(name, { environment, connectionString })
    ), requestTimeoutMs = 15_000,
    abortSignalFactory = (timeoutMs) => AbortSignal.timeout(timeoutMs) } = options;
  const connectionString = resolveReflectQueueConnection(baseUrl, environment);
  const main = queueClientFactory(connectionString, MAIN_QUEUE);
  const poison = queueClientFactory(connectionString, POISON_QUEUE);
  return async () => {
    let mainProperties;
    let poisonProperties;
    try {
      await Promise.all([
        preflightQueueReadAccess({ queue: main, environment, connectionString }),
        preflightQueueReadAccess({ queue: poison, environment, connectionString }),
      ]);
      [mainProperties, poisonProperties] = await Promise.all([
        main.getProperties({ abortSignal: abortSignalFactory(requestTimeoutMs) }),
        poison.getProperties({ abortSignal: abortSignalFactory(requestTimeoutMs) }),
      ]);
    } catch (error) {
      if (error instanceof StorageRbacError) throw error;
      fail("reflect queue properties request failed; state preserved");
    }
    const mainCount = mainProperties.approximateMessagesCount;
    const poisonCount = poisonProperties.approximateMessagesCount;
    if (!Number.isInteger(mainCount) || !Number.isInteger(poisonCount)) {
      fail("reflect queue properties returned invalid approximate counts");
    }
    return { main: mainCount, poison: poisonCount };
  };
}

export async function waitForReflectQueues(options) {
  const { readCounts, deadlineMs, intervalMs, now, sleep } = options;
  if (intervalMs < 2_000) fail("reflect queue observation interval must be at least 2000ms");
  const deadline = now() + deadlineMs;
  let firstZeroAt = null;
  let last = null;
  while (now() <= deadline) {
    last = await readCounts();
    if (last.poison > 0) fail(`reflect poison queue count is ${last.poison}; state preserved`);
    if (last.main === 0 && last.poison === 0) {
      if (firstZeroAt !== null && now() - firstZeroAt >= 2_000) {
        return { main: 0, poison: 0, stable: true };
      }
      if (firstZeroAt === null) firstZeroAt = now();
    } else {
      firstZeroAt = null;
    }
    if (now() >= deadline) break;
    await sleep(Math.min(intervalMs, deadline - now()));
  }
  fail(`timed out waiting for reflect queues; main=${last?.main ?? "unknown"} poison=${last?.poison ?? "unknown"}; state preserved`);
}
