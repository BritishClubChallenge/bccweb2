// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import * as z from "zod/v4";
import type { RescoreJob, RescoreJobMessage } from "@bccweb/types";

import { getPrivateBlobClient, writePrivateBlob } from "./blob.js";
import { getRuntimeQueueClient } from "./storageClients.js";

export const RESCORE_QUEUE_NAME = "rescore-jobs";

const STALE_ACTIVE_GUARD_MS = 12 * 60 * 1000;

export function statusBlobPath(jobId: string): string {
  return `rescore-jobs/${jobId}.json`;
}

export function activeGuardPath(roundId: string): string {
  return `rescore-jobs/active/${roundId}.json`;
}

export async function writeJobStatus(job: RescoreJob): Promise<void> {
  await writePrivateBlob(statusBlobPath(job.jobId), job);
}

export async function readJobStatus(jobId: string): Promise<RescoreJob | null> {
  try {
    const response = await getPrivateBlobClient(statusBlobPath(jobId)).download();
    const body = await streamToString(response.readableStreamBody);
    const parsed = JSON.parse(body) as RescoreJob;
    return parsed;
  } catch (err: unknown) {
    if (statusCodeOf(err) === 404) return null;
    throw err;
  }
}

export async function acquireActiveGuard(roundId: string): Promise<boolean> {
  const path = activeGuardPath(roundId);
  const client = getPrivateBlobClient(path);

  try {
    await writePrivateBlob(path, {}, undefined, { ifNoneMatch: "*" });
    return true;
  } catch (err: unknown) {
    if (!isConflict(err)) throw err;
  }

  let properties;
  try {
    properties = await client.getProperties();
  } catch (err: unknown) {
    // Guard was released between the conflict and here — try to re-acquire it.
    if (statusCodeOf(err) === 404) {
      try {
        await writePrivateBlob(path, {}, undefined, { ifNoneMatch: "*" });
        return true;
      } catch (err2: unknown) {
        if (isConflict(err2)) return false;
        throw err2;
      }
    }
    throw err;
  }
  const lastModified = properties.lastModified?.getTime();
  const ageMs = lastModified === undefined ? 0 : Date.now() - lastModified;
  if (!Number.isFinite(ageMs) || ageMs <= STALE_ACTIVE_GUARD_MS) return false;

  await client.deleteIfExists();

  try {
    await writePrivateBlob(path, {}, undefined, { ifNoneMatch: "*" });
    return true;
  } catch (err: unknown) {
    if (isConflict(err)) return false;
    throw err;
  }
}

export async function releaseActiveGuard(roundId: string): Promise<void> {
  await getPrivateBlobClient(activeGuardPath(roundId)).deleteIfExists();
}

// STRICT on purpose. The storage queue is NOT covered by the public-container
// privacy scanner (scripts/privacy-scan.mjs), so `.strict()` is the compensating
// control: it rejects ANY extra key (e.g. a PII field like requestedByEmail /
// requestedByIp) at parse time, before the message can be serialised into a
// queue message. Never add a field here beyond { jobId, roundId, requestedAt },
// and never drop `.strict()`. The worker reads PII from the status blob, not the
// message, so the message stays PII-free by construction.
export const RescoreJobMessageSchema = z
  .object({
    jobId: z.string(),
    roundId: z.string(),
    requestedAt: z.string(),
  })
  .strict();

export async function enqueueRescore(msg: RescoreJobMessage): Promise<void> {
  // Parse FIRST (strict schema) so a bad/extra field is rejected before anything
  // is serialised — no PII can leak into a queue message.
  const parsed = RescoreJobMessageSchema.parse(msg);
  const client = getRuntimeQueueClient(RESCORE_QUEUE_NAME);
  await client.createIfNotExists();
  await client.sendMessage(Buffer.from(JSON.stringify(parsed)).toString("base64"));
}

function statusCodeOf(err: unknown): number | undefined {
  return err instanceof Object && "statusCode" in err
    ? Number(err.statusCode)
    : undefined;
}

function isConflict(err: unknown): boolean {
  const statusCode = statusCodeOf(err);
  return statusCode === 409 || statusCode === 412;
}

async function streamToString(
  stream: NodeJS.ReadableStream | undefined,
): Promise<string> {
  if (!stream) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
