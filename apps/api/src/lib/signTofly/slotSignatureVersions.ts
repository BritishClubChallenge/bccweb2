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
 * Highest brief version signed for each slot, keyed by team and place.
 * Signatures predating brief versioning carry a null `briefVersion` and are
 * ignored — they can never satisfy a current-version check.
 */
export function latestSignedVersions(signatures: Signature[]): Map<string, number> {
  const latest = new Map<string, number>();
  for (const signature of signatures) {
    if (signature.briefVersion === null) continue;
    const key = slotKey(signature.teamId, signature.place);
    latest.set(key, Math.max(latest.get(key) ?? 0, signature.briefVersion));
  }
  return latest;
}

/** The version a signature must carry to count as current. Briefs written before versioning are version 1. */
export function currentBriefVersion(brief: RoundBrief & { version?: number }): number {
  return brief.version ?? 1;
}

/**
 * Whether the slot holds a signature at exactly `version`. A slot with no
 * signature at all, or whose latest signature is older, is not signed.
 */
export function isSignedAtVersion(
  latest: Map<string, number>,
  teamId: string,
  place: number,
  version: number,
): boolean {
  return latest.get(slotKey(teamId, place)) === version;
}

/**
 * Whether the slot was signed once but against an older brief. Distinct from
 * `!isSignedAtVersion`: a slot that was never signed is not superseded, so
 * callers that only demote stale signatures leave it untouched.
 */
export function isSupersededAtVersion(
  latest: Map<string, number>,
  teamId: string,
  place: number,
  version: number,
): boolean {
  const latestVersion = latest.get(slotKey(teamId, place));
  return latestVersion !== undefined && latestVersion < version;
}
