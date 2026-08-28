// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * Round-level authorization helpers (Security PR-1 — BOLA / IDOR).
 *
 * Centralises the "who may act on this round" rule that several handlers
 * (flights, rounds, brief, roundsMutate) previously each got wrong by
 * checking role membership (`isCoord`) WITHOUT scoping a RoundsCoord to the
 * round's organising club. The same organising-club rule is already enforced
 * (and tested) for the puretrack and brief-mutation endpoints; this module
 * makes it reusable so every round-scoped handler shares one correct definition.
 */

import type {
  CallerIdentity,
  PilotSlot,
  PilotSnapshot,
  Round,
  Team,
} from "@bccweb/types";
import { HttpError } from "./http.js";

type RoundClubScope = Pick<Round, "organisingClub">;
type RoundTeamsScope = Pick<Round, "teams">;

/**
 * Coarse role gate: is the caller a rounds coordinator at all? This is step 2
 * of the rateLimit.ts:138-164 ordering contract — it runs before any resource
 * read, so it CANNOT scope a RoundsCoord to a club. Always pair it with
 * `assertCanManageRound` (or a sibling) once the round has been read.
 */
export function isCoord(roles: string[]): boolean {
  return roles.includes("RoundsCoord") || roles.includes("Admin");
}

/**
 * True when the caller may MUTATE the round: an Admin, or a RoundsCoord whose
 * own club organises it. A RoundsCoord with no clubId, or whose clubId differs
 * from the round's organising club, is denied.
 */
export function canManageRound(
  caller: CallerIdentity,
  round: RoundClubScope,
): boolean {
  if (caller.roles.includes("Admin")) return true;
  return (
    caller.roles.includes("RoundsCoord") &&
    caller.clubId != null &&
    round.organisingClub?.id === caller.clubId
  );
}

/** Throw 403 unless the caller may manage (mutate) the round. */
export function assertCanManageRound(
  caller: CallerIdentity,
  round: RoundClubScope,
): void {
  if (!canManageRound(caller, round)) {
    throw new HttpError(
      403,
      "FORBIDDEN",
      "You can only manage rounds organised by your club",
    );
  }
}

/**
 * True when the caller may register/manage entries for ONE specific club in a
 * round: a full manager (Admin / organising-club coord), or any RoundsCoord
 * acting on their OWN club. This lets a club's coord enter that club's teams and
 * pilots into a round another club organises, without granting them control of
 * the round itself (status, metadata, brief — still canManageRound).
 */
export function canRegisterClubForRound(
  caller: CallerIdentity,
  round: RoundClubScope,
  clubId: string,
): boolean {
  if (canManageRound(caller, round)) return true;
  return (
    caller.roles.includes("RoundsCoord") &&
    caller.clubId != null &&
    caller.clubId === clubId
  );
}

/** Throw 403 unless the caller may register teams/pilots for `clubId`. */
export function assertCanRegisterForClub(
  caller: CallerIdentity,
  round: RoundClubScope,
  clubId: string,
): void {
  if (!canRegisterClubForRound(caller, round, clubId)) {
    throw new HttpError(
      403,
      "FORBIDDEN",
      "You can only register teams and pilots for your own club",
    );
  }
}

/**
 * True when the caller may mark ONE pilot slot as accounted-for. Three tiers:
 * - a manager (Admin / organising-club coord) — ANY slot in the round;
 * - the slot's team captain — ANY slot in THEIR team;
 * - the pilot themselves — their OWN slot only.
 */
export function canAccountForSlot(
  caller: CallerIdentity,
  round: RoundClubScope,
  team: Pick<Team, "captainPilotId">,
  slot: Pick<PilotSlot, "pilotId">,
): boolean {
  if (canManageRound(caller, round)) return true;
  if (caller.pilotId == null) return false;
  if (team.captainPilotId != null && team.captainPilotId === caller.pilotId) {
    return true;
  }
  return slot.pilotId != null && slot.pilotId === caller.pilotId;
}

/** Throw 403 unless the caller may mark this slot as accounted-for. */
export function assertCanAccountForSlot(
  caller: CallerIdentity,
  round: RoundClubScope,
  team: Pick<Team, "captainPilotId">,
  slot: Pick<PilotSlot, "pilotId">,
): void {
  if (!canAccountForSlot(caller, round, team, slot)) {
    throw new HttpError(
      403,
      "FORBIDDEN",
      "Only an admin, the organising club's coordinator, the team captain, or the pilot themselves can mark this slot accounted for",
    );
  }
}

/** True when the caller is a pilot occupying a filled slot in the round. */
export function isRoundParticipant(
  caller: CallerIdentity,
  round: RoundTeamsScope,
): boolean {
  const pilotId = caller.pilotId;
  if (!pilotId) return false;
  return round.teams.some((team) =>
    team.pilots.some(
      (slot) => slot.status === "Filled" && slot.pilotId === pilotId,
    ),
  );
}

/**
 * True when the caller may READ the round's private detail (incl. its brief):
 * a manager (Admin / organising-club coord) or a pilot flying in the round.
 */
export function canViewRoundDetail(
  caller: CallerIdentity,
  round: RoundClubScope & RoundTeamsScope,
): boolean {
  return canManageRound(caller, round) || isRoundParticipant(caller, round);
}

/**
 * Return a copy of the round with every pilot snapshot reduced to its non-PII
 * scoring fields (wingClass, pilotRating). Used for callers who may read a
 * round but must NOT see the per-pilot medical / emergency / contact PII
 * captured at lock time. wingClass + pilotRating are explicitly NOT PII (see
 * scripts/lib/pii.mjs) and are consumed by the brief UI, so they are retained.
 */
export function redactRoundSnapshots(round: Round): Round {
  return {
    ...round,
    teams: round.teams.map((team) => ({
      ...team,
      pilots: team.pilots.map((slot) => ({
        ...slot,
        snapshot: slot.snapshot
          ? ({
              wingClass: slot.snapshot.wingClass,
              pilotRating: slot.snapshot.pilotRating,
            } satisfies PilotSnapshot)
          : slot.snapshot,
      })),
    })),
  };
}
