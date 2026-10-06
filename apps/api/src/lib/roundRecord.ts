// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * The round record (issue #282, expand step): the single owner of the round
 * and brief blob paths, of which blob lease primitive each operation takes, of
 * the brief rollback and its telemetry, and of per-operation missing-round
 * semantics. The round-write executor is its first and only consumer; the old
 * primitives remain for every other caller.
 *
 * Per-operation semantics:
 *
 * | op                              | lease primitive                  | missing round           | non-404 error         |
 * | ---                             | ---                              | ---                     | ---                   |
 * | readRound                       | none                             | 404 NOT_FOUND HttpError | propagated unchanged  |
 * | mutateRound                     | plain private lease              | 404 NOT_FOUND HttpError | propagated unchanged  |
 * | mutateRoundRenewing             | renewing private lease           | 404 NOT_FOUND HttpError | propagated unchanged  |
 * | mutateRoundWithBrief            | round+brief lease                | 404 NOT_FOUND HttpError | propagated unchanged  |
 * | mutateRoundWithBriefOrRestore   | round+brief lease + brief restore | propagated unchanged (lock maps it) | propagated unchanged |
 * | mutateRoundWithPureTrackEchoes  | via mutatePureTrackEchoes        | propagated unchanged    | propagated unchanged  |
 *
 * The two non-translating operations exist for byte-compatibility with the
 * lock persist-failure answer and unlock's generic-catch answer; #283/#286
 * must preserve that.
 */

import type { Round, RoundBrief } from "@bccweb/types";
import { BriefSchema, RoundSchema } from "@bccweb/schemas";
import { getPrivateBlobClient, getPrivateBlockBlobClient, withPrivateLease, withPrivateLeaseRenewing, withRoundAndBriefLease } from "./blob.js";
import { readJson, writePrivateJson } from "./blobJson.js";
import { HttpError } from "./http.js";
import { mutatePureTrackEchoes } from "./puretrackStatus.js";
import { getTelemetryClient } from "./telemetry.js";

function roundPath(id: string): string {
  return `rounds/${id}.json`;
}

function briefPath(id: string): string {
  return `round-briefs/${id}.json`;
}

/**
 * A missing round blob — a lease acquisition or read that failed with a
 * storage 404, or a 404-status error thrown from a caller's step — becomes
 * the 404 answer. Duck-typed on the thrown object's own status code, exactly
 * as the executor did before the record existed; nothing else is translated.
 */
function translateMissingRound(err: unknown): never {
  const e = err as { statusCode?: number };
  if (e.statusCode === 404) throw new HttpError(404, "NOT_FOUND", "Round not found");
  throw err;
}

/** A committed mutation: the round object that was written (the same instance the step received) and the step's result. */
export interface RoundMutation<T> {
  readonly round: Round;
  readonly result: T;
}

/** A leased round and its leased brief, handed to a cross-blob step. */
export interface RoundAndBrief {
  readonly round: Round;
  readonly brief: RoundBrief;
}

/**
 * The two-stage step for the cross-blob operations: `beforeBrief` runs on the
 * leased round BEFORE the brief is read (the executor's status re-check), then
 * `mutate` changes both documents in memory.
 */
export interface RoundAndBriefSteps<T> {
  readonly beforeBrief: (round: Round) => void;
  readonly mutate: (docs: RoundAndBrief) => Promise<T>;
}

/** One unleased read of the round; a missing round becomes the 404 answer. */
export async function readRound(id: string): Promise<Round> {
  const path = roundPath(id);
  try {
    return await readJson(getPrivateBlobClient(path), RoundSchema, path);
  } catch (err: unknown) {
    translateMissingRound(err);
  }
}

/** Round mutation under a plain lease; a missing round becomes the 404 answer. */
export async function mutateRound<T>(
  id: string,
  step: (round: Round) => Promise<T>
): Promise<RoundMutation<T>> {
  const path = roundPath(id);
  try {
    return await withPrivateLease(path, async (leaseId) => {
      const round = await readJson(getPrivateBlobClient(path), RoundSchema, path);
      const result = await step(round);
      await writePrivateJson(path, RoundSchema, round, leaseId);
      return { round, result };
    });
  } catch (err: unknown) {
    translateMissingRound(err);
  }
}

/**
 * Round mutation under a renewing lease, for work too long for one 30s
 * acquisition; a missing round becomes the 404 answer.
 */
export async function mutateRoundRenewing<T>(
  id: string,
  step: (round: Round) => Promise<T>
): Promise<RoundMutation<T>> {
  const path = roundPath(id);
  try {
    return await withPrivateLeaseRenewing(path, async (leaseId) => {
      const round = await readJson(getPrivateBlobClient(path), RoundSchema, path);
      const result = await step(round);
      await writePrivateJson(path, RoundSchema, round, leaseId);
      return { round, result };
    });
  } catch (err: unknown) {
    translateMissingRound(err);
  }
}

/**
 * Round-and-brief mutation under the joint lease: the round is read,
 * beforeBrief runs, the brief is read, mutate changes both, then the BRIEF is
 * written BEFORE the round so a crash never leaves the round pointing at an
 * unfrozen brief. A missing round becomes the 404 answer.
 */
export async function mutateRoundWithBrief<T>(
  id: string,
  steps: RoundAndBriefSteps<T>
): Promise<RoundMutation<T>> {
  const path = roundPath(id);
  const bPath = briefPath(id);
  try {
    return await withRoundAndBriefLease(id, async (roundLeaseId, briefLeaseId) => {
      const round = await readJson(getPrivateBlobClient(path), RoundSchema, path);
      steps.beforeBrief(round);
      const brief = await readJson(getPrivateBlobClient(bPath), BriefSchema, bPath);
      const result = await steps.mutate({ round, brief });
      await writePrivateJson(bPath, BriefSchema, brief, briefLeaseId);
      await writePrivateJson(path, RoundSchema, round, roundLeaseId);
      return { round, result };
    });
  } catch (err: unknown) {
    translateMissingRound(err);
  }
}

/**
 * Round-and-brief mutation with a byte-exact brief restore: if the round write
 * fails after the brief was written, the brief's captured raw bytes are put
 * back under its lease, and a failed restore emits the reconcile event with
 * `operation`. NO missing-round translation: every error propagates as the
 * identical object (the lock runner maps it to its persist-failure answer).
 */
export function mutateRoundWithBriefOrRestore<T>(
  id: string,
  operation: string,
  steps: RoundAndBriefSteps<T>
): Promise<RoundMutation<T>> {
  const path = roundPath(id);
  const bPath = briefPath(id);
  return withRoundAndBriefLease(id, async (roundLeaseId, briefLeaseId) => {
    const round = await readJson(getPrivateBlobClient(path), RoundSchema, path);
    steps.beforeBrief(round);
    const brief = await readJson(getPrivateBlobClient(bPath), BriefSchema, bPath);
    const briefClient = getPrivateBlockBlobClient(bPath);
    const originalBriefBytes = await briefClient.downloadToBuffer();
    const result = await steps.mutate({ round, brief });
    await writePrivateJson(bPath, BriefSchema, brief, briefLeaseId);
    try {
      await writePrivateJson(path, RoundSchema, round, roundLeaseId);
    } catch (roundWriteError: unknown) {
      await briefClient
        .upload(originalBriefBytes, originalBriefBytes.length, {
          blobHTTPHeaders: { blobContentType: "application/json" },
          conditions: { leaseId: briefLeaseId },
        })
        .catch((rollbackError: unknown) => {
          getTelemetryClient()?.trackEvent({
            name: "puretrack.crossBlobReconcileRequired",
            properties: {
              roundId: id,
              operation,
              roundWriteError: roundWriteError instanceof Error ? roundWriteError.name : "unknown",
              rollbackError: rollbackError instanceof Error ? rollbackError.name : "unknown",
            },
          });
        });
      throw roundWriteError;
    }
    return { round, result };
  });
}

/**
 * Round-and-brief mutation delegating the whole lease/read/clone/write/
 * rollback lifecycle to mutatePureTrackEchoes. NO translation: every error
 * propagates as the identical object.
 */
export async function mutateRoundWithPureTrackEchoes<T>(
  id: string,
  step: (docs: RoundAndBrief) => Promise<T>
): Promise<RoundMutation<T>> {
  let committed: RoundMutation<T> | undefined;
  await mutatePureTrackEchoes(id, async ({ round, brief }) => {
    const result = await step({ round, brief });
    committed = { round, result };
    return true;
  });
  // Defensive guard moved from the executor: every path either throws or
  // commits, but an uncommitted mutation is a 500, never an empty success.
  if (committed === undefined) throw new HttpError(500, "INTERNAL");
  return committed;
}
