// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import type { RoundBrief, Signature } from "@bccweb/types";

/**
 * The sign-to-fly brief-version rule, owned in one place.
 *
 * A slot counts as signed only while its most recent signature was made against
 * the brief version currently frozen on the round. Three callers depend on that
 * single rule and must never drift apart:
 *
 * - `materializeSignToFly` reflects it onto `slot.signToFly`;
 * - `findUnsignedSlots` gates the lock on it;
 * - `invalidatePriorSignToFlyFlags` demotes slots a brief edit superseded.
 *
 * If they disagreed, the lock gate could admit a signature the flags call stale
 * (or refuse one they call current), so the shared projection and predicates
 * live here rather than being restated per call site.
 */

/**
 * Map key identifying one slot: its team plus its place in that team. Exported
 * so callers indexing their own per-slot maps share this key space.
 */
export function slotKey(teamId: string, place: number): string {
  return `${teamId}:${place}`;
}

/**
 * Map key identifying one PILOT's occupancy of one slot. A slot's occupant
 * can change over time (roster swap), and the sign-to-fly resolution must
 * judge each occupant by their OWN signature history — not whichever
 * occupant signed most recently for that slot position — or a pilot
 * returning to a slot they previously signed can be shadowed by a later
 * occupant's signature and never recover without a coordinator override.
 */
export function slotPilotKey(teamId: string, place: number, pilotId: string): string {
  return `${teamId}:${place}:${pilotId}`;
}

/** The newest signature recorded for one pilot's occupancy of a slot. */
export type LatestSignature = { version: number; pilotId: string; signedAt: string | null };

/**
 * Newest signature for each pilot's occupancy of a slot, keyed by team,
 * place, and pilot. Signatures predating brief versioning carry a null
 * `briefVersion` and are ignored — they can never satisfy a current-version
 * check.
 *
 * Equal versions are broken by `signedAt`, newest wins. Override signatures are
 * written to random-suffixed paths (`overrideSignaturePath`), so one slot can
 * hold several signatures at the same version — for different pilots, after a
 * roster swap — and blob listing order is lexicographic on that random suffix,
 * not chronological. Without the tie-break the winner would be arbitrary and the
 * gate could reject the pilot who actually signed. Keying on the pilot as well as
 * the slot keeps that tie-break scoped to a single pilot's own signatures, so a
 * different pilot who later occupies (and signs) the same slot can never shadow
 * this pilot's own record.
 */
export function latestSignedVersions(signatures: Signature[]): Map<string, LatestSignature> {
  const latest = new Map<string, LatestSignature>();
  for (const signature of signatures) {
    if (signature.briefVersion === null) continue;
    const key = slotPilotKey(signature.teamId, signature.place, signature.pilotId);
    const current = latest.get(key);
    if (current === undefined || isNewer(signature, current)) {
      latest.set(key, {
        version: signature.briefVersion,
        pilotId: signature.pilotId,
        signedAt: signature.signedAt,
      });
    }
  }
  return latest;
}

function isNewer(candidate: Signature, current: LatestSignature): boolean {
  const version = candidate.briefVersion ?? 0;
  if (version !== current.version) return version > current.version;
  // A null signedAt carries no recency, so it loses to any timestamped signature.
  return (candidate.signedAt ?? "") > (current.signedAt ?? "");
}

/** The version a signature must carry to count as current. Briefs written before versioning are version 1. */
export function currentBriefVersion(brief: RoundBrief & { version?: number }): number {
  return brief.version ?? 1;
}

/**
 * Whether `pilotId` holds a signature on this slot at exactly `version`.
 *
 * The pilot must match. Team rosters are NOT material brief fields, so swapping
 * a pilot into an occupied place leaves the brief version untouched; without the
 * pilot check the previous occupant's signature would authorize the new pilot to
 * fly. An empty slot (`pilotId === null`) is never signed.
 */
export function isSignedAtVersion(
  latest: Map<string, LatestSignature>,
  teamId: string,
  place: number,
  version: number,
  pilotId: string | null,
): boolean {
  if (pilotId === null) return false;
  const entry = latest.get(slotPilotKey(teamId, place, pilotId));
  return entry !== undefined && entry.version === version;
}

/**
 * Whether the slot was signed once but against an older brief. Distinct from
 * `!isSignedAtVersion`: a slot that was never signed is not superseded, so
 * callers that only demote stale signatures leave it untouched.
 */
export function isSupersededAtVersion(
  latest: Map<string, LatestSignature>,
  teamId: string,
  place: number,
  version: number,
  pilotId: string | null,
): boolean {
  if (pilotId === null) return false;
  const entry = latest.get(slotPilotKey(teamId, place, pilotId));
  return entry !== undefined && entry.version < version;
}
