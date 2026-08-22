// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import type { Round, RoundBrief, Team } from "@bccweb/types";
import { expect } from "vitest";
import {
  makeClub,
  makePilot,
  makeRound,
  writePrivateJson,
} from "../../__tests__/helpers/seed.js";
import { computeBriefHash } from "../../lib/signTofly/briefVersion.js";
import { writeSignature } from "../../lib/signTofly/ledger.js";
import {
  invokeEvidenceHandler,
  makeEvidenceRequest,
  seedEvidenceUser,
} from "./issue8EvidenceHarness.js";

export async function roundForOtherClub(
  status: Round["status"] = "Proposed"
): Promise<Round> {
  return makeRound({ organisingClubId: randomUUID(), status });
}

// Builds a Locked round whose only Filled slot is pre-signed at the frozen
// brief version. The lock gate (lockRound → listSignaturesForRound) schema-
// reads every blob under signatures/{roundId}/, so the signature must be
// schema-valid and `writeSignature`-create-only at the canonical path.
export async function roundWithFlight(
  flightId: string,
  ownerPilotId: string
): Promise<Round> {
  const clubId = randomUUID();
  const teamId = randomUUID();
  const roundId = randomUUID();
  const siteId = randomUUID();
  const date = "2026-06-09";
  const team: Team = {
    id: teamId,
    teamName: "Flight Team",
    club: { id: clubId, name: "Flight Club" },
    score: 0,
    pilots: [
      {
        placeInTeam: 1,
        pilotId: ownerPilotId,
        isScoring: true,
        status: "Filled",
        accountedFor: false,
        signToFly: false,
        noScore: false,
        pilotPoints: 0,
        snapshot: { wingClass: "EN B", pilotRating: "Pilot" },
        flight: {
          id: flightId,
          distance: 10,
          duration: 60,
          scoringType: "XC",
          score: 0,
          wingFactor: 1,
          isManualLog: false,
        },
      },
    ],
  };
  const brief: RoundBrief & { version: number } = {
    roundId,
    version: 1,
    generatedAt: "2026-06-01T08:00:00.000Z",
    date,
    siteName: "Flight Site",
    teams: [],
    windSpeedDirection: "W 10kt",
  };
  brief.hash = computeBriefHash(brief);
  const round: Round = {
    id: roundId,
    date,
    status: "Locked",
    isLocked: true,
    maxTeams: 8,
    minimumScore: 0,
    site: { id: siteId, name: brief.siteName },
    organisingClub: { id: clubId, name: "Flight Club" },
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
    pilotId: ownerPilotId,
    userId: randomUUID(),
    signedAt: new Date().toISOString(),
    briefVersion: 1,
    briefHash: brief.hash,
    wordingVersion: 1,
    wordingHash: "issue8-wording-hash",
    ip: "203.0.113.1",
    userAgent: "issue8-fixture",
    source: "pilot-self",
  });
  return round;
}

export async function seedPilotSeasonClubAssignment(
  seasonYear: number,
  clubId: string
): Promise<string> {
  const club = await makeClub({
    id: clubId,
    name: `Season Club ${clubId.slice(0, 6)}`,
  });
  const admin = await seedEvidenceUser({ roles: ["Admin"] });
  const createSeasonClub = await invokeEvidenceHandler(
    "createSeasonClub",
    makeEvidenceRequest(admin, {
      method: "POST",
      params: { year: String(seasonYear) },
      body: { clubId: club.id, numTeams: 1, acceptTsCs: true },
    })
  );
  expect([201, 409]).toContain(createSeasonClub.status);
  const pilot = await makePilot();
  const assign = await invokeEvidenceHandler(
    "assignPilotSeasonClub",
    makeEvidenceRequest(admin, {
      method: "POST",
      body: { pilotId: pilot.id, clubId: club.id, seasonYear },
    })
  );
  expect(assign.status).toBe(201);
  return pilot.id;
}
