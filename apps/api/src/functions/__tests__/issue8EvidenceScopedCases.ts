// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import type { Round, RoundBrief, Team } from "@bccweb/types";
import { makeClubTeam, makeRound, makeSite, writePrivateJson } from "../../__tests__/helpers/seed.js";
import { computeBriefHash } from "../../lib/signTofly/briefVersion.js";
import { writeSignature } from "../../lib/signTofly/ledger.js";
import type { CallSiteCase } from "./issue8EvidenceHarness.js";
import { crossClubCoord } from "./issue8EvidenceHarness.js";
import {
  roundForOtherClub,
  seedPilotSeasonClubAssignment,
} from "./issue8EvidenceFixtures.js";

// Builds a Locked round with a Filled pilot AND a current-version signature so
// the cross-club 403 path is exercised (no business mutation). Mirrors
// issue8EvidenceFixtures.roundWithFlight — keep the two locked-fixture
// constructions consistent so a future reader sees the same shape.
async function seedLockedRoundWithSignedFilledSlot(
  teamName: string,
  clubName: string
): Promise<{ round: { id: string }; team: Team }> {
  const clubId = randomUUID();
  const teamId = randomUUID();
  const roundId = randomUUID();
  const siteId = randomUUID();
  const date = "2026-06-09";
  const pilotId = randomUUID();
  const team: Team = {
    id: teamId,
    teamName,
    club: { id: clubId, name: clubName },
    score: 0,
    pilots: [
      {
        placeInTeam: 1,
        pilotId,
        isScoring: true,
        status: "Filled",
        accountedFor: false,
        signToFly: false,
        noScore: false,
        pilotPoints: 0,
        snapshot: { wingClass: "EN B", pilotRating: "Pilot" },
        flight: null,
      },
    ],
  };
  const brief: RoundBrief & { version: number } = {
    roundId,
    version: 1,
    generatedAt: "2026-06-01T08:00:00.000Z",
    date,
    siteName: `${clubName} Site`,
    teams: [],
    windSpeedDirection: "W 10kt",
  };
  brief.hash = computeBriefHash(brief);
  const round: Round = {
    id: roundId,
    date,
    status: "Locked" as const,
    isLocked: true,
    maxTeams: 8,
    minimumScore: 0,
    site: { id: siteId, name: brief.siteName },
    organisingClub: { id: clubId, name: clubName },
    season: { year: 2026 },
    teams: [team],
    brief: {
      version: 1,
      jsonPath: `round-briefs/${roundId}.json`,
      pdfPath: `round-briefs/${roundId}.pdf`,
      generatedAt: brief.generatedAt,
    },
  };
  await writePrivateJson(`rounds/${roundId}.json`, round);
  await writePrivateJson(`round-briefs/${roundId}.json`, brief);
  await writeSignature({
    id: randomUUID(),
    roundId,
    teamId,
    place: 1,
    pilotId,
    userId: randomUUID(),
    signedAt: new Date().toISOString(),
    briefVersion: 1,
    briefHash: brief.hash,
    wordingVersion: 1,
    wordingHash: "issue8-scoped-wording-hash",
    ip: "203.0.113.2",
    userAgent: "issue8-scoped-fixture",
    source: "pilot-self",
  });
  return { round, team };
}

/**
 * A round organised by another club, parked at `Cancelled` — the only status
 * `uncancelRound` accepts. `roundForOtherClub("Cancelled")` cannot produce one:
 * seed.ts's `transitionRound` only walks the
 * Proposed→Confirmed→BriefComplete→Locked→Complete spine and silently hands back
 * a Proposed round for anything off it, which would leave this row asserting 403
 * over a request that would have 409'd anyway. Forcing the status by blob write
 * is the roundTransitionTable.test.ts `seedRoundAt` idiom.
 */
async function cancelledRoundForOtherClub(): Promise<Round> {
  const round = await roundForOtherClub("Proposed");
  const cancelled: Round = { ...round, status: "Cancelled", isLocked: false };
  await writePrivateJson(`rounds/${round.id}.json`, cancelled);
  return cancelled;
}

export const SCOPED_CASES: readonly CallSiteCase[] = [
  { file: "brief.ts", handler: "updateRoundBrief", endpoint: "updateRoundBrief", tier: "heavy", forbiddenKind: "coord-scope", setup: async () => ({ forbidden: await crossClubCoord(), request: { method: "PUT", params: { id: (await roundForOtherClub("Confirmed")).id }, body: {} } }) },
  { file: "brief.ts", handler: "regenerateRoundBriefPdf", endpoint: "regenerateRoundBriefPdf", tier: "heavy", forbiddenKind: "coord-scope", setup: async () => ({ forbidden: await crossClubCoord(), request: { method: "POST", params: { id: (await roundForOtherClub("Locked")).id } } }) },
  { file: "brief.ts", handler: "uploadBriefImage", endpoint: "uploadBriefImage", tier: "standard", forbiddenKind: "coord-scope", setup: async () => ({ forbidden: await crossClubCoord(), request: { method: "POST", params: { id: (await roundForOtherClub("Confirmed")).id } } }) },
  { file: "brief.ts", handler: "deleteBriefImage", endpoint: "deleteBriefImage", tier: "standard", forbiddenKind: "coord-scope", setup: async () => ({ forbidden: await crossClubCoord(), request: { method: "DELETE", params: { id: (await roundForOtherClub("Confirmed")).id, index: "1" } } }) },
  { file: "clubTeams.ts", handler: "createClubTeam", endpoint: "createClubTeam", tier: "standard", forbiddenKind: "coord-scope", setup: async () => ({ forbidden: await crossClubCoord(), request: { method: "POST", body: { clubId: randomUUID(), seasonYear: 2026, teamName: "Other" } } }) },
  { file: "clubTeams.ts", handler: "updateClubTeam", endpoint: "updateClubTeam", tier: "standard", forbiddenKind: "coord-scope", setup: async () => ({ forbidden: await crossClubCoord(), request: { method: "PUT", params: { id: (await makeClubTeam({ clubId: randomUUID(), seasonYear: 2026, teamName: `Other-${randomUUID().slice(0, 6)}` })).id }, body: { teamName: "Nope" } } }) },
  { file: "clubTeams.ts", handler: "deleteClubTeam", endpoint: "deleteClubTeam", tier: "standard", forbiddenKind: "coord-scope", setup: async () => ({ forbidden: await crossClubCoord(), request: { method: "DELETE", params: { id: (await makeClubTeam({ clubId: randomUUID(), seasonYear: 2026, teamName: `Delete-${randomUUID().slice(0, 6)}` })).id } } }) },
  { file: "pilotSeasonClubs.ts", handler: "assignPilotSeasonClub", endpoint: "assignPilotSeasonClub", tier: "standard", forbiddenKind: "coord-scope", setup: async () => ({ forbidden: await crossClubCoord(), request: { method: "POST", body: { pilotId: randomUUID(), clubId: randomUUID(), seasonYear: 2026 } } }) },
  { file: "pilotSeasonClubs.ts", handler: "deletePilotSeasonClub", endpoint: "deletePilotSeasonClub", tier: "standard", forbiddenKind: "coord-scope", setup: async () => { const clubId = randomUUID(); const pilotId = await seedPilotSeasonClubAssignment(2026, clubId); return { forbidden: await crossClubCoord(), request: { method: "DELETE", params: { pilotId, seasonYear: "2026" } } }; } },
  { file: "puretrack.ts", handler: "createPureTrackGroups", endpoint: "createPureTrackGroups", tier: "heavy", forbiddenKind: "coord-scope", setup: async () => ({ forbidden: await crossClubCoord(), request: { method: "POST", params: { id: (await roundForOtherClub("Locked")).id } } }) },
  // The four pure transitions (lib/roundTransitions.ts). These are coord-SCOPE
  // rather than coord-coarse on purpose: the coarse `isCoord` gate runs outside
  // the lease and would prove nothing about the ordering this file exists to
  // pin. Only a RoundsCoord who CLEARS the coarse gate reaches
  // assertCanManageRound inside the lease, where it must still beat the
  // saturated mutationRateLimit that follows it. Each round is seeded in a
  // status its transition legally accepts, so the 403 is shown to beat a request
  // that would otherwise have succeeded, not one already doomed to 409.
  { file: "roundTransitions.ts", handler: "confirmRound", endpoint: "confirmRound", tier: "standard", forbiddenKind: "coord-scope", setup: async () => ({ forbidden: await crossClubCoord(), request: { method: "POST", params: { id: (await roundForOtherClub("Proposed")).id } } }) },
  { file: "roundTransitions.ts", handler: "reopenBrief", endpoint: "reopenBrief", tier: "standard", forbiddenKind: "coord-scope", setup: async () => ({ forbidden: await crossClubCoord(), request: { method: "POST", params: { id: (await roundForOtherClub("BriefComplete")).id } } }) },
  { file: "roundTransitions.ts", handler: "cancelRound", endpoint: "cancelRound", tier: "standard", forbiddenKind: "coord-scope", setup: async () => ({ forbidden: await crossClubCoord(), request: { method: "POST", params: { id: (await roundForOtherClub("Confirmed")).id } } }) },
  { file: "roundTransitions.ts", handler: "uncancelRound", endpoint: "uncancelRound", tier: "standard", forbiddenKind: "coord-scope", setup: async () => ({ forbidden: await crossClubCoord(), request: { method: "POST", params: { id: (await cancelledRoundForOtherClub()).id } } }) },
  { file: "sites.ts", handler: "createSite", endpoint: "createSite", tier: "standard", forbiddenKind: "coord-scope", setup: async () => ({ forbidden: await crossClubCoord(), request: { method: "POST", body: { name: "Other Site", clubId: randomUUID() } } }) },
  { file: "sites.ts", handler: "updateSite", endpoint: "updateSite", tier: "standard", forbiddenKind: "coord-scope", setup: async () => ({ forbidden: await crossClubCoord(), request: { method: "PUT", params: { id: (await makeSite({ clubId: randomUUID() })).id }, body: { parkingW3W: "///nope.nope.nope" } } }) },
  { file: "sites.ts", handler: "deleteSite", endpoint: "deleteSite", tier: "standard", forbiddenKind: "coord-scope", setup: async () => ({ forbidden: await crossClubCoord(), request: { method: "DELETE", params: { id: (await makeSite({ clubId: randomUUID() })).id } } }) },
  { file: "teams.ts", handler: "updateAccounted", endpoint: "updateAccounted", tier: "standard", forbiddenKind: "coord-scope", setup: async () => { const { round, team } = await seedLockedRoundWithSignedFilledSlot("Acct Team", "Acct Club"); return { forbidden: await crossClubCoord(), request: { method: "PUT", params: { id: round.id, teamId: team.id, place: "1" }, body: { accountedFor: true } } }; } },
  { file: "teamsCaptain.ts", handler: "setTeamCaptain", endpoint: "setTeamCaptain", tier: "standard", forbiddenKind: "coord-scope", setup: async () => { const clubId = randomUUID(); const round = await makeRound({ organisingClubId: clubId, teams: [{ id: "t1", club: { id: clubId, name: "Other" }, teamName: "T", score: 0, captainPilotId: null, pilots: [] }] }); return { forbidden: await crossClubCoord(), request: { method: "PUT", params: { id: round.id, teamId: "t1" }, body: { pilotId: null } } }; } },
];
