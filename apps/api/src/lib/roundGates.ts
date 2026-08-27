// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import type { Round } from "@bccweb/types";

/**
 * One offending slot in a round-lifecycle 409 detail. `pilotId` is nullable
 * because the accounted-for gate reports occupied-but-unidentified slots too.
 */
export interface SlotRef {
  teamName: string;
  placeInTeam: number;
  pilotId: string | null;
}

/**
 * Render offending slots for an `HttpError` detail string, e.g.
 * `Alpha #1 (uuid); Bravo #2 (null)`. Shared by `lockRound`'s
 * `SIGNATURES_INCOMPLETE` gate and `completeRound`'s `PILOTS_NOT_ACCOUNTED_FOR`
 * gate so the two conflict details stay identical in shape.
 */
export function formatSlotRefs(slots: readonly SlotRef[]): string {
  return slots.map((s) => `${s.teamName} #${s.placeInTeam} (${s.pilotId})`).join("; ");
}

/**
 * Filled slots not yet marked accounted-for — the post-flight safety sweep
 * `completeRound` requires before a round may leave `Locked`.
 *
 * Unlike `findUnsignedSlots` (which skips slots with no `pilotId`), a Filled
 * slot with a null `pilotId` still counts: being accounted for is a
 * physical-presence check independent of pilot identity. `noScore` is likewise
 * irrelevant — a pilot who scores nothing still has to be present and safe.
 *
 * That function stays in `signTofly/completeness.ts` because it needs the brief
 * and the signature ledger; this one needs only the round.
 */
export function findUnaccountedSlots(round: Round): SlotRef[] {
  const unaccounted: SlotRef[] = [];
  for (const team of round.teams) {
    for (const slot of team.pilots) {
      if (slot.status === "Filled" && slot.accountedFor !== true) {
        unaccounted.push({
          teamName: team.teamName,
          placeInTeam: slot.placeInTeam,
          pilotId: slot.pilotId,
        });
      }
    }
  }
  return unaccounted;
}
