// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import type { Round, RoundBrief, Signature } from "@bccweb/types";

/**
 * Slots whose sign-to-fly ledger has no signature at the current brief version.
 * Mirrors `materializeSignToFly`'s version rule exactly: signatures with a null
 * briefVersion are skipped, the highest version per team:place wins, and the
 * current version is `brief.version ?? 1`. A slot is unsigned when it is Filled
 * (has a pilot) and its latest signature version does not equal the current one —
 * a missing signature counts as unsigned.
 */
export function findUnsignedSlots(
  round: Round,
  brief: RoundBrief & { version?: number },
  signatures: Signature[],
): Array<{ teamId: string; teamName: string; placeInTeam: number; pilotId: string }> {
  const currentBriefVersion = brief.version ?? 1;
  const latest = new Map<string, number>();

  for (const signature of signatures) {
    if (signature.briefVersion === null) continue;
    const key = slotKey(signature.teamId, signature.place);
    latest.set(key, Math.max(latest.get(key) ?? 0, signature.briefVersion));
  }

  const unsigned: Array<{ teamId: string; teamName: string; placeInTeam: number; pilotId: string }> = [];
  for (const team of round.teams) {
    for (const slot of team.pilots) {
      if (!slot.pilotId || slot.status !== "Filled") continue;
      const latestVersion = latest.get(slotKey(team.id, slot.placeInTeam));
      if (latestVersion !== currentBriefVersion) {
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

function slotKey(teamId: string, place: number): string {
  return `${teamId}:${place}`;
}
