// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import type { Round, RoundBrief, Signature } from "@bccweb/types";

import { listSignaturesForOccupancy, listSignaturesForRound } from "./ledger.js";

/**
 * The single owner of the sign-to-fly rule: who has signed the current brief
 * for this round?
 *
 * Every safety gate derives from this module so they can never drift apart:
 *
 * - the lock gate (`roundsMutate.ts`) resolves the round-wide ledger and asks
 *   `unsignedSlots` before materializing flags with `applyTo`;
 * - brief-complete resolves the ledger against the freshly bumped brief and
 *   demotes superseded flags with `demoteSuperseded` (real and dryRun);
 * - the reflect job (`reflect.ts`) replays the ledger onto `slot.signToFly`
 *   with `applyTo` inside the round lease;
 * - self-unregistration (`roundUnregistration.ts`) asks the occupancy-scoped
 *   ledger `hasSignedAnyVersion`.
 *
 * The rule is computed once from a signature list (`signatureLedgerView`) and
 * then asked questions. Occupancies are keyed `${teamId}:${place}:${pilotId}`
 * from the signature PAYLOAD fields; signatures predating brief versioning
 * (`briefVersion === null`) are ignored. The latest signature per key follows a
 * total order — higher `briefVersion` wins; equal versions break by
 * `(signedAt ?? "")` descending; equal `signedAt` breaks by `id` descending —
 * so the result never depends on blob listing order. No public method returns
 * the winning `Signature` object; callers read only the resolved predicates.
 */
export interface Occupancy {
  readonly teamId: string;
  readonly place: number;
  readonly pilotId: string;
}

export interface UnsignedSlot {
  teamId: string;
  teamName: string;
  placeInTeam: number;
  pilotId: string;
}

export interface SignToFlyResolution {
  readonly briefVersion: number;
  isSigned(occupancy: Occupancy): boolean;
  unsignedSlots(round: Round): UnsignedSlot[];
  applyTo(round: Round): boolean;
  demoteSuperseded(round: Round): number;
}

export interface SignatureLedgerView {
  hasSignedAnyVersion(occupancy: Occupancy): boolean;
  resolveAgainst(brief: RoundBrief & { version?: number }): SignToFlyResolution;
}

/** The version a signature must carry to count as current. Briefs written before versioning are version 1. */
export function currentBriefVersion(brief: RoundBrief & { version?: number }): number {
  return brief.version ?? 1;
}

/**
 * The newest signature recorded for one pilot's occupancy of one slot. The map
 * key already identifies the pilot, so the entry itself carries no `pilotId`;
 * `id` survives only to make the equal-version equal-`signedAt` tie-break total.
 */
type ResolvedSignature = { version: number; signedAt: string | null; id: string };

export function signatureLedgerView(signatures: readonly Signature[]): SignatureLedgerView {
  const latest = new Map<string, ResolvedSignature>();
  for (const signature of signatures) {
    if (signature.briefVersion === null) continue;
    const key = `${signature.teamId}:${signature.place}:${signature.pilotId}`;
    const current = latest.get(key);
    if (current === undefined || isNewer(signature, current)) {
      latest.set(key, {
        version: signature.briefVersion,
        signedAt: signature.signedAt,
        id: signature.id,
      });
    }
  }

  const entryFor = (occupancy: Occupancy): ResolvedSignature | undefined =>
    latest.get(`${occupancy.teamId}:${occupancy.place}:${occupancy.pilotId}`);

  return {
    hasSignedAnyVersion(occupancy: Occupancy): boolean {
      return entryFor(occupancy) !== undefined;
    },
    resolveAgainst(brief: RoundBrief & { version?: number }): SignToFlyResolution {
      const briefVersion = currentBriefVersion(brief);
      return {
        briefVersion,
        isSigned(occupancy: Occupancy): boolean {
          return entryFor(occupancy)?.version === briefVersion;
        },
        unsignedSlots(round: Round): UnsignedSlot[] {
          const unsigned: UnsignedSlot[] = [];
          for (const team of round.teams) {
            for (const slot of team.pilots) {
              if (!slot.pilotId || slot.status !== "Filled") continue;
              const entry = entryFor({ teamId: team.id, place: slot.placeInTeam, pilotId: slot.pilotId });
              if (entry?.version !== briefVersion) {
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
        },
        applyTo(round: Round): boolean {
          let changed = false;
          for (const team of round.teams) {
            for (const slot of team.pilots) {
              const next =
                slot.pilotId === null
                  ? false
                  : entryFor({ teamId: team.id, place: slot.placeInTeam, pilotId: slot.pilotId })
                      ?.version === briefVersion;
              if (slot.signToFly !== next) {
                slot.signToFly = next;
                changed = true;
              }
            }
          }
          return changed;
        },
        demoteSuperseded(round: Round): number {
          let count = 0;
          for (const team of round.teams) {
            for (const slot of team.pilots) {
              if (slot.pilotId === null) continue;
              const entry = entryFor({ teamId: team.id, place: slot.placeInTeam, pilotId: slot.pilotId });
              // A slot that was never signed (no versioned entry — legacy-only,
              // U4) is not superseded, so its flag is left untouched; only an
              // entry that EXISTS and predates the brief is demoted.
              if (entry !== undefined && entry.version < briefVersion) {
                if (slot.signToFly === true) count += 1;
                slot.signToFly = false;
              }
            }
          }
          return count;
        },
      };
    },
  };
}

function isNewer(candidate: Signature, current: ResolvedSignature): boolean {
  const version = candidate.briefVersion ?? 0;
  if (version !== current.version) return version > current.version;
  // A null signedAt carries no recency, so it loses to any timestamped signature.
  const signedAt = candidate.signedAt ?? "";
  const currentSignedAt = current.signedAt ?? "";
  if (signedAt !== currentSignedAt) return signedAt > currentSignedAt;
  // Same version, same timestamp (possible across random-suffixed override
  // blobs): break on id so the winner never depends on listing order.
  return candidate.id > current.id;
}

/** Round-wide ledger; errors from the listing propagate to the caller. */
export async function readRoundSignatureLedger(roundId: string): Promise<SignatureLedgerView> {
  return signatureLedgerView(await listSignaturesForRound(roundId));
}

/** Occupancy-scoped ledger; errors from the listing propagate to the caller. */
export async function readOccupancySignatureLedger(
  roundId: string,
  occupancy: Occupancy,
): Promise<SignatureLedgerView> {
  return signatureLedgerView(
    await listSignaturesForOccupancy(roundId, occupancy.teamId, occupancy.place, occupancy.pilotId),
  );
}
