// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import type { Round, RoundBrief, Signature } from "@bccweb/types";

import { currentBriefVersion, isSignedAtVersion, latestSignedVersions } from "./slotSignatureVersions.js";

/**
 * Slots blocking a lock: those that are Filled (have a pilot) but hold no
 * signature at the round's current brief version. A missing signature, one
 * against an older brief, and one signed by a pilot who no longer occupies the
 * slot all count as unsigned.
 *
 * The version rule itself lives in `slotSignatureVersions.js`, shared with the
 * reflect job, so the gate and `slot.signToFly` can never disagree.
 */
export function findUnsignedSlots(
  round: Round,
  brief: RoundBrief & { version?: number },
  signatures: Signature[],
): Array<{ teamId: string; teamName: string; placeInTeam: number; pilotId: string }> {
  const version = currentBriefVersion(brief);
  const latest = latestSignedVersions(signatures);

  const unsigned: Array<{ teamId: string; teamName: string; placeInTeam: number; pilotId: string }> = [];
  for (const team of round.teams) {
    for (const slot of team.pilots) {
      if (!slot.pilotId || slot.status !== "Filled") continue;
      if (!isSignedAtVersion(latest, team.id, slot.placeInTeam, version, slot.pilotId)) {
        unsigned.push({
          teamId: team.id,
          teamName: team.teamName,
          placeInTeam: slot.placeInTeam,
          pilotId: slot.pilotId,
        });
      }
    }
  }

  return unsigned;
}
