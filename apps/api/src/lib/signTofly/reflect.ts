// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { BriefSchema, RoundSchema } from "@bccweb/schemas";
import type { Round, RoundBrief, Signature } from "@bccweb/types";

import { getPrivateBlobClient, withPrivateLeaseRetry } from "../blob.js";
import { readJson, writePrivateJson } from "../blobJson.js";
import { listSignaturesForRound } from "./ledger.js";
import { currentBriefVersion, isSignedAtVersion, latestSignedVersions } from "./slotSignatureVersions.js";

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
    const signatures = await listSignaturesForRound(roundId);

    const changed = materializeSignToFly(round, brief, signatures);
    if (changed) await writePrivateJson(roundPath, RoundSchema, round, leaseId);
  });
}

export function materializeSignToFly(
  round: Round,
  brief: RoundBrief & { version?: number },
  signatures: Signature[],
): boolean {
  const version = currentBriefVersion(brief);
  const latest = latestSignedVersions(signatures);

  let changed = false;
  for (const team of round.teams) {
    for (const slot of team.pilots) {
      const next = isSignedAtVersion(latest, team.id, slot.placeInTeam, version, slot.pilotId);
      if (slot.signToFly !== next) {
        slot.signToFly = next;
        changed = true;
      }
    }
  }

  return changed;
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
