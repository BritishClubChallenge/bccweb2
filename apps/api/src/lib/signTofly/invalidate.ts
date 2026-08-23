// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import type { Round, RoundBrief, Signature } from "@bccweb/types";

import { currentBriefVersion, isSupersededAtVersion, latestSignedVersions } from "./slotSignatureVersions.js";

export function invalidatePriorSignToFlyFlags(
  round: Round,
  brief: RoundBrief,
  signatures: Signature[],
): Round {
  const version = currentBriefVersion(brief);
  const latest = latestSignedVersions(signatures);

  for (const team of round.teams) {
    for (const slot of team.pilots) {
      if (isSupersededAtVersion(latest, team.id, slot.placeInTeam, version, slot.pilotId)) {
        slot.signToFly = false;
      }
    }
  }

  return round;
}
