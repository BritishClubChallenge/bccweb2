// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { IgcValidationJobSchema } from "@bccweb/schemas";
import type { FlightValidation, IgcValidationJob } from "@bccweb/types";
import * as z from "zod/v4";
import {
  getPrivateBlobClient,
  getPrivateBlockBlobClient,
  readBlob,
  withPrivateLeaseRenewing,
  writePrivateBlob,
} from "./blob.js";
import { getRuntimeQueueClient } from "./storageClients.js";

export const IGC_VALIDATION_QUEUE_NAME = "igc-validation";

const GUARD_PATH = "igc-validation/active.json";
const GUARD_LEASE_SECONDS = 60;
const MIN_CALL_INTERVAL_MS = 2_000;
const GUARD_COMPLETION_MARGIN_MS = 8_000;
const DEFAULT_FAI_VALI_TIMEOUT_MS = 20_000;
const GUARD_RENEW_INTERVAL_MS = 15_000;
const MAX_FAI_VALI_TIMEOUT_MS = GUARD_LEASE_SECONDS * 1_000
  - MIN_CALL_INTERVAL_MS
  - GUARD_COMPLETION_MARGIN_MS;

const ValidationResultSchema = z
  .object({
    signature: z.enum(["valid", "invalid", "unverified", "pending"]).optional(),
    date: z.enum(["valid", "invalid"]).optional(),
    overridden: z.boolean().optional(),
    overriddenBy: z.string().optional(),
    overriddenAt: z.string().optional(),
    checkedAt: z.string().optional(),
    validationAttemptId: z.string().optional(),
    faiStatus: z.string().optional(),
    faiServer: z.string().optional(),
    faiMsg: z.string().optional(),
  })
  .strict() satisfies z.ZodType<FlightValidation>;

type IgcValidationGuardOptions = {
  readonly leaseDurationSec?: number;
  readonly renewIntervalMs?: number;
};

export class IgcValidationGuardContendedError extends Error {
  readonly name = "IgcValidationGuardContendedError";

  constructor(options: ErrorOptions) {
    super("IGC validation guard is owned by another worker", options);
  }
}

export async function enqueueIgcValidation(
  job: IgcValidationJob,
  opts?: { visibilityTimeoutSeconds?: number },
): Promise<void> {
  const parsed = IgcValidationJobSchema.parse(job);
  const message = Buffer.from(JSON.stringify(parsed)).toString("base64");
  const client = getRuntimeQueueClient(IGC_VALIDATION_QUEUE_NAME);
  await client.createIfNotExists();
  const visibilityTimeout = opts?.visibilityTimeoutSeconds;
  if (visibilityTimeout === undefined) {
    await client.sendMessage(message);
    return;
  }
  await client.sendMessage(message, { visibilityTimeout });
}

export async function acquireIgcValidationGuard(): Promise<{ leaseId: string }> {
  await ensureIgcValidationGuardBlob();
  const leaseClient = getPrivateBlockBlobClient(GUARD_PATH).getBlobLeaseClient();
  const response = await leaseClient.acquireLease(GUARD_LEASE_SECONDS);
  const leaseId = response.leaseId;
  if (!leaseId) {
    throw new Error("IGC validation guard lease did not return a leaseId");
  }
  return { leaseId };
}

export async function releaseIgcValidationGuard(leaseId: string): Promise<void> {
  await getPrivateBlockBlobClient(GUARD_PATH)
    .getBlobLeaseClient(leaseId)
    .releaseLease();
}

export async function renewIgcValidationGuard(leaseId: string): Promise<void> {
  await getPrivateBlockBlobClient(GUARD_PATH)
    .getBlobLeaseClient(leaseId)
    .renewLease();
}

export async function withIgcValidationGuard<T>(
  fn: (leaseId: string) => Promise<T>,
  options: IgcValidationGuardOptions = {},
): Promise<T> {
  await ensureIgcValidationGuardBlob();
  let enteredGuard = false;
  try {
    return await withPrivateLeaseRenewing(
      GUARD_PATH,
      async (leaseId) => {
        enteredGuard = true;
        return fn(leaseId);
      },
      {
        leaseDurationSec: options.leaseDurationSec ?? GUARD_LEASE_SECONDS,
        renewIntervalMs: options.renewIntervalMs ?? GUARD_RENEW_INTERVAL_MS,
      },
    );
  } catch (error: unknown) {
    if (!enteredGuard && isLeaseContention(error)) {
      throw new IgcValidationGuardContendedError({ cause: error });
    }
    throw error;
  }
}

export function assertFaiValiTimeoutWithinGuard(): void {
  const timeoutMs = Number(
    process.env["FAI_VALI_TIMEOUT_MS"] ?? DEFAULT_FAI_VALI_TIMEOUT_MS,
  );
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("FAI_VALI_TIMEOUT_MS must be a positive finite number");
  }
  if (timeoutMs > MAX_FAI_VALI_TIMEOUT_MS) {
    throw new Error(
      `FAI_VALI_TIMEOUT_MS must be at most ${MAX_FAI_VALI_TIMEOUT_MS}ms`,
    );
  }
}

export async function waitForPace(leaseId: string): Promise<void> {
  const client = getPrivateBlockBlobClient(GUARD_PATH);
  const properties = await client.getProperties({ conditions: { leaseId } });
  const previousValue = properties.metadata?.["lastCallStartedAt"]
    ?? properties.metadata?.["lastcallstartedat"];
  const previousStartedAt = previousValue === undefined
    ? undefined
    : Date.parse(previousValue);
  if (previousStartedAt !== undefined && Number.isFinite(previousStartedAt)) {
    const earliestStart = previousStartedAt + MIN_CALL_INTERVAL_MS;
    while (Date.now() < earliestStart) {
      await new Promise((resolve) =>
        setTimeout(resolve, earliestStart - Date.now()),
      );
    }
  }
}

export async function recordFaiCallStart(leaseId: string): Promise<Date> {
  const client = getPrivateBlockBlobClient(GUARD_PATH);
  const startedAt = new Date();
  await client.setMetadata(
    { lastCallStartedAt: startedAt.toISOString() },
    { conditions: { leaseId } },
  );
  return startedAt;
}

export async function paceBeforeFaiCall(leaseId: string): Promise<Date> {
  await waitForPace(leaseId);
  return recordFaiCallStart(leaseId);
}

export async function writeValidationResult(
  attemptId: string,
  result: FlightValidation,
): Promise<void> {
  const parsed = ValidationResultSchema.parse(result);
  await writePrivateBlob(validationResultPath(attemptId), parsed, undefined, {
    ifNoneMatch: "*",
  });
}

export async function readValidationResult(
  attemptId: string,
): Promise<FlightValidation | null> {
  try {
    const raw = await readBlob(getPrivateBlobClient(validationResultPath(attemptId)));
    return ValidationResultSchema.parse(raw);
  } catch (error: unknown) {
    if (statusCodeOf(error) === 404) return null;
    throw error;
  }
}

export async function deleteValidationResult(attemptId: string): Promise<void> {
  await getPrivateBlobClient(validationResultPath(attemptId)).deleteIfExists();
}

async function ensureIgcValidationGuardBlob(): Promise<void> {
  try {
    await writePrivateBlob(GUARD_PATH, {}, undefined, { ifNoneMatch: "*" });
  } catch (error: unknown) {
    const statusCode = statusCodeOf(error);
    if (statusCode !== 409 && statusCode !== 412) throw error;
  }
}

function validationResultPath(attemptId: string): string {
  return `igc-validation/results/${attemptId}.json`;
}

function statusCodeOf(error: unknown): number | undefined {
  return error instanceof Object && "statusCode" in error
    ? Number(error.statusCode)
    : undefined;
}

function isLeaseContention(error: unknown): boolean {
  const statusCode = statusCodeOf(error);
  return statusCode === 409 || statusCode === 412;
}
