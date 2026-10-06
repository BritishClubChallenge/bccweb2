// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { BriefSchema, RoundSchema } from "@bccweb/schemas";
import type { RoundBrief } from "@bccweb/types";

import { getPrivateBlobClient, withPrivateLeaseRetry } from "../blob.js";
import { readJson, writePrivateJson } from "../blobJson.js";
import { readRoundSignatureLedger } from "./resolution.js";

type RoundBriefWithVersion = RoundBrief & { version?: number };

export async function reflectRoundSignToFly(roundId: string): Promise<void> {
  const roundPath = `rounds/${roundId}.json`;

  await withPrivateLeaseRetry(roundPath, async (leaseId) => {
    const round = await readJson(getPrivateBlobClient(roundPath), RoundSchema, roundPath);
    if (round.status !== "BriefComplete") return;

    const brief = await readBriefOrNull(roundId);
    if (!brief) return;

    // List INSIDE the lease so an older reflect job cannot commit a stale
    // signature snapshot after a newer reflect already materialized the round
    // (cross-instance last-writer-wins would otherwise regress signToFly
    // true -> false). The round lease serialises the snapshot with the write.
    const ledger = await readRoundSignatureLedger(roundId);
    const changed = ledger.resolveAgainst(brief).applyTo(round);
    if (changed) await writePrivateJson(roundPath, RoundSchema, round, leaseId);
  });
}

async function readBriefOrNull(roundId: string): Promise<RoundBriefWithVersion | null> {
  const path = `round-briefs/${roundId}.json`;
  try {
    return await readJson(getPrivateBlobClient(path), BriefSchema, path);
  } catch (err: unknown) {
    if (isMissingBlob(err)) return null;
    throw err;
  }
}

function isMissingBlob(err: unknown): boolean {
  return typeof err === "object" && err !== null && "statusCode" in err && err.statusCode === 404;
}
