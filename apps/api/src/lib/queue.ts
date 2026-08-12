// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import type { QueueClient } from "@azure/storage-queue";
import * as z from "zod/v4";
import {
  getRuntimeQueueClient,
  resetStorageClientSingletons,
} from "./storageClients.js";

// ─── Brief-PDF job contract ───────────────────────────────────────────────────

export interface BriefPdfJob {
  roundId: string;
  briefVersion: number;
  pdfAttemptId: string;
}

export interface SignToFlyReflectJob {
  roundId: string;
}

export interface PureTrackGroupJob {
  roundId: string;
  attemptId: string;
}

// STRICT on purpose. The storage queue is NOT covered by the public-container
// privacy scanner (scripts/privacy-scan.mjs), so `.strict()` is the compensating
// control: it rejects ANY extra key (e.g. a PII field) at parse time, before the
// job can be serialised into a queue message. Never add a field here beyond
// { roundId, briefVersion, pdfAttemptId }, and never drop `.strict()`.
//
// Key order matters: Zod `.parse` on a `z.object` preserves the declared key
// order, so declaring keys as roundId → briefVersion → pdfAttemptId fixes the
// JSON byte layout the consumer (a v4 storage-queue trigger that base64-decodes
// then JSON-parses) receives.
export const BriefPdfJobSchema = z
  .object({
    roundId: z.string().min(1),
    briefVersion: z.number().int(),
    pdfAttemptId: z.string().min(1),
  })
  .strict();

// STRICT on purpose. The storage queue is NOT covered by the public-container
// privacy scanner (scripts/privacy-scan.mjs), so `.strict()` is the compensating
// control: it rejects ANY extra key (e.g. a PII field) at parse time, before the
// job can be serialised into a queue message. Never add a field here beyond
// { roundId }, and never drop `.strict()`.
export const SignToFlyReflectJobSchema = z
  .object({ roundId: z.string().min(1) })
  .strict();

export const PureTrackGroupJobSchema = z
  .object({
    roundId: z.string().min(1),
    attemptId: z.string().min(1),
  })
  .strict();

export const PURETRACK_GROUP_QUEUE_NAME = "round-puretrack-group";

// ─── Client singleton ─────────────────────────────────────────────────────────

const _clients = new Map<string, QueueClient>();

// TEST-ONLY: clears the cached QueueClient so the next enqueue re-reads
// AzureWebJobsStorage from env. Mirrors resetBlobSingletons in lib/blob.ts;
// wired into __tests__/helpers/setup.ts so each test file starts clean.
export function resetQueueSingletons(): void {
  _clients.clear();
  resetStorageClientSingletons();
}

function getQueueClient(queueName: string): QueueClient {
  const cached = _clients.get(queueName);
  if (cached) return cached;
  const queueClient = getRuntimeQueueClient(queueName);
  _clients.set(queueName, queueClient);
  return queueClient;
}

// ─── Producer ─────────────────────────────────────────────────────────────────

/**
 * Enqueue a brief-PDF render job onto the `round-brief-pdf` queue.
 *
 * Parses the job FIRST (strict schema) so a bad/extra field is rejected before
 * anything is serialised — no PII can leak into a queue message. The validated
 * JSON is base64-encoded to match the v4 storage-queue trigger, which
 * base64-decodes then JSON-parses the message body.
 */
export async function enqueueBriefPdf(job: BriefPdfJob): Promise<void> {
  const parsed = BriefPdfJobSchema.parse(job);
  const message = Buffer.from(JSON.stringify(parsed)).toString("base64");
  await getQueueClient("round-brief-pdf").sendMessage(message);
}

/**
 * Enqueue a SignToFly reflection job onto the `signtofly-reflect` queue.
 *
 * Parses the job FIRST (strict schema) so a bad/extra field is rejected before
 * anything is serialised — no PII can leak into a queue message. The validated
 * JSON is base64-encoded to match the v4 storage-queue trigger, which
 * base64-decodes then JSON-parses the message body.
 */
export async function enqueueSignToFlyReflect(
  job: SignToFlyReflectJob,
): Promise<void> {
  const parsed = SignToFlyReflectJobSchema.parse(job);
  const message = Buffer.from(JSON.stringify(parsed)).toString("base64");
  await getQueueClient("signtofly-reflect").sendMessage(message);
}

export async function enqueuePureTrackGroupJob(
  job: PureTrackGroupJob,
  options?: { visibilityTimeoutSeconds?: number },
): Promise<void> {
  const parsed = PureTrackGroupJobSchema.parse(job);
  const visibilityTimeout = options?.visibilityTimeoutSeconds;
  if (
    visibilityTimeout !== undefined &&
    (!Number.isInteger(visibilityTimeout) ||
      visibilityTimeout < 0 ||
      visibilityTimeout > 604_800)
  ) {
    throw new RangeError(
      "visibilityTimeoutSeconds must be an integer between 0 and 604800",
    );
  }
  const message = Buffer.from(JSON.stringify(parsed)).toString("base64");
  const queueClient = getQueueClient(PURETRACK_GROUP_QUEUE_NAME);
  if (visibilityTimeout === undefined) {
    await queueClient.sendMessage(message);
    return;
  }
  await queueClient.sendMessage(message, { visibilityTimeout });
}
