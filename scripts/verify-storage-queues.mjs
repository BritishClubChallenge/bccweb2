#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { createQueueServiceClient } from "./lib/storageClients.mjs";

const expectedQueues = [
  "round-brief-pdf",
  "round-brief-pdf-poison",
  "signtofly-reflect",
  "signtofly-reflect-poison",
  "rescore-jobs",
  "rescore-jobs-poison",
  "round-puretrack-group",
  "round-puretrack-group-poison",
  "igc-validation",
  "igc-validation-poison",
];

export async function verifyStorageQueues(queueService = createQueueServiceClient()) {
  const listedQueues = new Set();
  for await (const queue of queueService.listQueues()) listedQueues.add(queue.name);

  for (const queueName of expectedQueues) {
    if (!listedQueues.has(queueName)) throw new Error(`Required queue is missing: ${queueName}`);
    const queue = queueService.getQueueClient(queueName);
    const properties = await queue.getProperties();
    const peek = await queue.peekMessages({ numberOfMessages: 1 });
    console.log(
      `[PASS] ${queueName}: approximateMessagesCount=${properties.approximateMessagesCount ?? "unknown"} ` +
        `peeked=${peek.peekedMessageItems.length}`,
    );
  }
}

verifyStorageQueues().catch((error) => {
  console.error(`[FAIL] ${error instanceof Error ? error.message : "Unknown queue verification error"}`);
  process.exitCode = 1;
});
