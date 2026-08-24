// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * Regression tests for Security PR-1 — Broken Object-Level Authorization (BOLA / IDOR).
 *
 * These started life as exploit PoCs (securityPhase2*.poc.test.ts) that PROVED:
 *   A — a cross-club RoundsCoord could mutate another club's round / teams
 *   B — a cross-club RoundsCoord could modify/delete another club's flight
 *   C — any authenticated user could read a round's per-pilot medical/emergency PII
 *   D — any authenticated user could read any round's private brief (JSON/PDF/image)
 *
 * Each assertion below is the INVERSE of the original exploit: the attack must now
 * be denied (403 / PII stripped) while the legitimate actor (Admin, organising-club
 * coord, or participating pilot) is still allowed.
 *
 * Local-only: handlers invoked over the mocked @azure/functions registry; per-file
 * Azurite container; no network.
 */
import { randomUUID } from "crypto";
import { describe, expect, test } from "vitest";
import type { PilotSummary, Round, RoundBrief, Team } from "@bccweb/types";
import { invoke, makeAuthRequest } from "../../__tests__/helpers/api.js";
import {
  makeClub,
  makeClubTeam,
  makePilot,
  makeUser,
  readPrivateJson,
  readPublicJson,
  writePrivateJson,
  writePublicJson,
} from "../../__tests__/helpers/seed.js";
import { getPrivateBlockBlobClient } from "../../lib/blob.js";
import "../admin.js";
import "../authFunctions.js";
import "../clubs.js";
import "../pilots.js";
import "../seasons.js";
import "../sites.js";
import "../clubTeams.js";
import "../rounds.js";
import "../roundsMutate.js";
import "../teams.js";
import "../flights.js";
import "../brief.js";

// Randomise the source IP per request so the mutation rate-limiter (keyed on
// x-forwarded-for) never trips between steps.
function authReq(
  user: { id: string; email: string },
  options: NonNullable<Parameters<typeof makeAuthRequest>[2]>,
) {
  return makeAuthRequest(user.id, user.email, {
    ...options,
    headers: {
      ...options.headers,
      "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 250) + 1}`,
    },
  });
}

// ─── Candidate A — cross-club round / team mutation ───────────────────────────

async function seedCrossClubRound() {
  const year = 9300 + Math.floor(Math.random() * 300);
  const clubA = await makeClub({ name: "Attacker Club A" });
  const clubB = await makeClub({ name: "Organising Club B" });
  await makeClubTeam({
    clubId: clubB.id,
    clubName: clubB.name,
    seasonYear: year,
    teamName: "Home Team",
  });
  await makeClubTeam({
    clubId: clubA.id,
    clubName: clubA.name,
    seasonYear: year,
    teamName: "Visitor Team",
  });
  const victimTeam: Team = {
    id: "victim-team",
    teamName: "Victim Team",
    club: { id: clubB.id, name: clubB.name },
    score: 0,
    pilots: [],
  };
  const round: Round = {
    id: `bola-a-${randomUUID().slice(0, 8)}`,
    date: "2026-06-15",
    status: "Proposed",
    isLocked: false,
    maxTeams: 8,
    minimumScore: 0,
    site: { id: "site-a", name: "Site A" },
    organisingClub: { id: clubB.id, name: clubB.name },
    season: { year },
    teams: [victimTeam],
  };
  await writePrivateJson(`rounds/${round.id}.json`, round);
  const { user: coordA } = await makeUser({
    roles: ["RoundsCoord"],
    clubId: clubA.id,
    emailVerified: true,
  });
  const { user: coordB } = await makeUser({
    roles: ["RoundsCoord"],
    clubId: clubB.id,
    emailVerified: true,
  });
  return { clubA, clubB, round, coordA, coordB };
}

describe("BOLA A — cross-club round/team mutation", () => {
  test("cross-club RoundsCoord cannot add or remove teams (403, no side effect)", async () => {
    const { clubB, round, coordA } = await seedCrossClubRound();

    const addRes = await invoke(
      "addTeam",
      authReq(coordA, {
        method: "POST",
        params: { id: round.id },
        body: { clubId: clubB.id, teamName: "Home Team" },
      }),
    );
    expect(addRes.status).toBe(403);

    const removeRes = await invoke(
      "removeTeam",
      authReq(coordA, {
        method: "DELETE",
        params: { id: round.id, teamId: "victim-team" },
      }),
    );
    expect(removeRes.status).toBe(403);

    const after = await readPrivateJson<Round>(`rounds/${round.id}.json`);
    expect(after?.teams.map((t) => t.id)).toEqual(["victim-team"]);
  });

  test("organising-club RoundsCoord can add a team (200)", async () => {
    const { clubB, round, coordB } = await seedCrossClubRound();

    const addRes = await invoke(
      "addTeam",
      authReq(coordB, {
        method: "POST",
        params: { id: round.id },
        body: { clubId: clubB.id, teamName: "Home Team" },
      }),
    );
    expect(addRes.status).toBe(200);
    expect((addRes.jsonBody as Round).teams.at(-1)?.teamName).toBe("Home Team");
  });

  test("non-host RoundsCoord can register their OWN club's team + pilot, but not another club's", async () => {
    const { clubA, round, coordA } = await seedCrossClubRound();

    const addOwn = await invoke(
      "addTeam",
      authReq(coordA, {
        method: "POST",
        params: { id: round.id },
        body: { clubId: clubA.id, teamName: "Visitor Team" },
      }),
    );
    expect(addOwn.status).toBe(200);
    const ownTeam = (addOwn.jsonBody as Round).teams.find((t) => t.club.id === clubA.id);
    expect(ownTeam?.teamName).toBe("Visitor Team");

    const pilot = await makePilot({ clubId: clubA.id, firstName: "Visit", lastName: "Pilot" });
    const addPilotRes = await invoke(
      "addPilot",
      authReq(coordA, {
        method: "POST",
        params: { id: round.id, teamId: ownTeam!.id },
        body: { pilotId: pilot.id },
      }),
    );
    expect(addPilotRes.status).toBe(200);

    const deniedPilot = await invoke(
      "addPilot",
      authReq(coordA, {
        method: "POST",
        params: { id: round.id, teamId: "victim-team" },
        body: { pilotId: pilot.id },
      }),
    );
    expect(deniedPilot.status).toBe(403);

    const after = await readPrivateJson<Round>(`rounds/${round.id}.json`);
    expect(after?.teams.find((t) => t.club.id === clubA.id)?.pilots.map((s) => s.pilotId)).toContain(pilot.id);
    expect(after?.teams.find((t) => t.id === "victim-team")?.pilots).toHaveLength(0);
  });

  test("cross-club RoundsCoord cannot edit a round's brief (403); organising coord can (200)", async () => {
    const { round, coordA, coordB } = await seedCrossClubRound();

    const denied = await invoke(
      "updateRoundBrief",
      authReq(coordA, {
        method: "PUT",
        params: { id: round.id },
        body: { airspaceAndHazards: "hijacked" },
      }),
    );
    expect(denied.status).toBe(403);

    const allowed = await invoke(
      "updateRoundBrief",
      authReq(coordB, {
        method: "PUT",
        params: { id: round.id },
        body: { airspaceAndHazards: "legitimate update" },
      }),
    );
    expect(allowed.status).toBe(200);
    expect((allowed.jsonBody as RoundBrief).airspaceAndHazards).toBe("legitimate update");
  });
});

// ─── Candidate B — cross-club flight mutation ─────────────────────────────────

async function seedLockedRoundWithFlight() {
  const clubA = await makeClub({ name: "B Attacker Club A" });
  const clubB = await makeClub({ name: "B Organising Club B" });
  const victimPilot = await makePilot({
    firstName: "Victim",
    lastName: "Pilot",
    clubId: clubB.id,
  });
  const flightId = `bola-b-flight-${randomUUID().slice(0, 8)}`;
  const round: Round = {
    id: `bola-b-${randomUUID().slice(0, 8)}`,
    date: "2026-06-15",
    status: "Locked",
    isLocked: true,
    maxTeams: 8,
    minimumScore: 0,
    site: { id: "site-b", name: "Site B" },
    organisingClub: { id: clubB.id, name: clubB.name },
    season: { year: 2026 },
    teams: [
      {
        id: "team-b",
        teamName: "Team B",
        club: { id: clubB.id, name: clubB.name },
        score: 0,
        pilots: [
          {
            placeInTeam: 1,
            isScoring: true,
            status: "Filled",
            accountedFor: false,
            signToFly: false,
            noScore: false,
            pilotPoints: 0,
            pilotId: victimPilot.id,
            snapshot: null,
            flight: {
              id: flightId,
              distance: 50,
              duration: 3600,
              scoringType: "XC",
              score: 0,
              wingFactor: 1,
              isManualLog: false,
            },
          },
        ],
      },
    ],
  };
  await writePrivateJson(`rounds/${round.id}.json`, round);
  const { user: coordA } = await makeUser({
    roles: ["RoundsCoord"],
    clubId: clubA.id,
    emailVerified: true,
  });
  const { user: victimUser } = await makeUser({
    roles: ["Pilot"],
    pilotId: victimPilot.id,
    clubId: clubB.id,
    emailVerified: true,
  });
  return { round, flightId, coordA, victimUser };
}

describe("BOLA B — cross-club flight mutation", () => {
  test("cross-club RoundsCoord cannot update or delete a flight (403, no side effect)", async () => {
    const { round, flightId, coordA } = await seedLockedRoundWithFlight();

    const updateRes = await invoke(
      "updateFlight",
      authReq(coordA, {
        method: "PUT",
        params: { id: round.id, flightId },
        body: { distance: 999 },
      }),
    );
    expect(updateRes.status).toBe(403);

    const deleteRes = await invoke(
      "deleteFlight",
      authReq(coordA, {
        method: "DELETE",
        params: { id: round.id, flightId },
      }),
    );
    expect(deleteRes.status).toBe(403);

    const after = await readPrivateJson<Round>(`rounds/${round.id}.json`);
    expect(after?.teams[0]?.pilots[0]?.flight?.distance).toBe(50);
    expect(after?.teams[0]?.pilots[0]?.flight?.id).toBe(flightId);
  });

  test("the flight's own pilot can still update it (200)", async () => {
    const { round, flightId, victimUser } = await seedLockedRoundWithFlight();

    const res = await invoke(
      "updateFlight",
      authReq(victimUser, {
        method: "PUT",
        params: { id: round.id, flightId },
        body: { distance: 75 },
      }),
    );
    // flights.ts echoes the Round on success (its `status` field is the round
    // state, not an HTTP code — a pre-existing quirk outside this PR's scope), so
    // the authorization path is proven by absence of 401/403 + the persisted edit.
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    const after = await readPrivateJson<Round>(`rounds/${round.id}.json`);
    expect(after?.teams[0]?.pilots[0]?.flight?.distance).toBe(75);
  });
});

// ─── Candidate C — per-pilot snapshot PII disclosure ──────────────────────────

async function seedRoundWithSnapshotPii() {
  const orgClubId = randomUUID();
  const pilot = await makePilot({ firstName: "Snap", lastName: "Pilot" });
  const round: Round = {
    id: `bola-c-${randomUUID().slice(0, 8)}`,
    date: "2026-06-15",
    status: "Locked",
    isLocked: true,
    maxTeams: 8,
    minimumScore: 0,
    site: { id: "site-c", name: "Site C" },
    organisingClub: { id: orgClubId, name: "C Org Club" },
    season: { year: 2026 },
    teams: [
      {
        id: "team-c",
        teamName: "Team C",
        club: { id: orgClubId, name: "C Org Club" },
        score: 0,
        pilots: [
          {
            placeInTeam: 1,
            isScoring: true,
            status: "Filled",
            accountedFor: false,
            signToFly: false,
            noScore: false,
            pilotPoints: 0,
            pilotId: pilot.id,
            snapshot: {
              wingClass: "EN B",
              pilotRating: "Pilot",
              phoneNumber: "07123 000000",
              emergencyContactName: "Emergency Person",
              emergencyPhoneNumber: "07999 111222",
              medicalInfo: "Type 1 diabetes; carries insulin",
              helmetColour: "red",
            },
            flight: null,
          },
        ],
      },
    ],
  };
  await writePrivateJson(`rounds/${round.id}.json`, round);
  const { user: outsider } = await makeUser({
    roles: ["Pilot"],
    pilotId: "00000000-0000-4000-8000-0000000000b2",
    clubId: "00000000-0000-4000-8000-0000000000b3",
    emailVerified: true,
  });
  const { user: orgCoord } = await makeUser({
    roles: ["RoundsCoord"],
    clubId: orgClubId,
    emailVerified: true,
  });
  return { round, outsider, orgCoord };
}

describe("BOLA C — round snapshot PII disclosure", () => {
  test("unrelated authenticated user gets the round with snapshot PII stripped", async () => {
    const { round, outsider } = await seedRoundWithSnapshotPii();

    const res = await invoke(
      "getRoundById",
      authReq(outsider, { method: "GET", params: { id: round.id } }),
    );

    expect(res.status).toBe(200);
    const snapshot = (res.jsonBody as Round).teams[0].pilots[0].snapshot!;
    expect(snapshot.medicalInfo).toBeUndefined();
    expect(snapshot.emergencyContactName).toBeUndefined();
    expect(snapshot.emergencyPhoneNumber).toBeUndefined();
    expect(snapshot.phoneNumber).toBeUndefined();
    expect(snapshot.helmetColour).toBeUndefined();
    // Non-PII scoring fields are retained so the UI still renders.
    expect(snapshot.wingClass).toBe("EN B");
    expect(snapshot.pilotRating).toBe("Pilot");
  });

  test("organising-club coord still sees full snapshot PII", async () => {
    const { round, orgCoord } = await seedRoundWithSnapshotPii();

    const res = await invoke(
      "getRoundById",
      authReq(orgCoord, { method: "GET", params: { id: round.id } }),
    );

    expect(res.status).toBe(200);
    const snapshot = (res.jsonBody as Round).teams[0].pilots[0].snapshot!;
    expect(snapshot.medicalInfo).toBe("Type 1 diabetes; carries insulin");
    expect(snapshot.emergencyPhoneNumber).toBe("07999 111222");
  });
});

// ─── Candidate D — round brief disclosure ─────────────────────────────────────

async function seedRoundWithBrief() {
  const orgClubId = randomUUID();
  const participant = await makePilot({ firstName: "Brief", lastName: "Flyer" });
  const round: Round = {
    id: `bola-d-${randomUUID().slice(0, 8)}`,
    date: "2026-06-15",
    status: "Locked",
    isLocked: true,
    maxTeams: 8,
    minimumScore: 0,
    site: { id: "site-d", name: "Site D" },
    organisingClub: { id: orgClubId, name: "D Org Club" },
    season: { year: 2026 },
    teams: [
      {
        id: "team-d",
        teamName: "Team D",
        club: { id: orgClubId, name: "D Org Club" },
        score: 0,
        pilots: [
          {
            placeInTeam: 1,
            isScoring: true,
            status: "Filled",
            accountedFor: false,
            signToFly: false,
            noScore: false,
            pilotPoints: 0,
            pilotId: participant.id,
            snapshot: null,
            flight: null,
          },
        ],
      },
    ],
  };
  await writePrivateJson(`rounds/${round.id}.json`, round);

  const brief: RoundBrief = {
    roundId: round.id,
    generatedAt: "2026-06-15T08:00:00.000Z",
    date: "2026-06-15",
    siteName: "Sensitive Site",
    organisingClubName: "D Org Club",
    briefingTime: "09:00",
    windSpeedDirection: "12kt SW",
    airspaceAndHazards: "Sensitive hazard notes",
    NOTAMs: "Sensitive NOTAM detail",
    briefersNotes: "Do not publish this note",
    briefer: {
      name: "Brief Owner",
      phoneNumber: "07000 222333",
      emailAddress: "brief-owner@example.test",
    },
    imagePaths: [`round-briefs/${round.id}/image-1.png`],
    teams: [],
  };
  await writePrivateJson(`round-briefs/${round.id}.json`, brief);
  const pdf = Buffer.from("%PDF-1.4\nprivate brief PDF\n%%EOF");
  await getPrivateBlockBlobClient(`round-briefs/${round.id}.pdf`).uploadData(pdf, {
    blobHTTPHeaders: { blobContentType: "application/pdf" },
    metadata: { sitename: "Sensitive Site", date: "2026-06-15" },
  });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x70]);
  await getPrivateBlockBlobClient(`round-briefs/${round.id}/image-1.png`).uploadData(png, {
    blobHTTPHeaders: { blobContentType: "image/png" },
  });

  const { user: outsider } = await makeUser({
    roles: ["Pilot"],
    pilotId: "00000000-0000-4000-8000-0000000000b4",
    clubId: "00000000-0000-4000-8000-0000000000b5",
    emailVerified: true,
  });
  const { user: orgCoord } = await makeUser({
    roles: ["RoundsCoord"],
    clubId: orgClubId,
    emailVerified: true,
  });
  const { user: participantUser } = await makeUser({
    roles: ["Pilot"],
    pilotId: participant.id,
    clubId: "00000000-0000-4000-8000-0000000000b5",
    emailVerified: true,
  });
  return { round, outsider, orgCoord, participantUser };
}

describe("BOLA D — round brief disclosure", () => {
  test("unrelated authenticated user is denied the brief JSON, PDF, and image (403)", async () => {
    const { round, outsider } = await seedRoundWithBrief();

    const jsonRes = await invoke(
      "getRoundBrief",
      authReq(outsider, { method: "GET", params: { id: round.id } }),
    );
    expect(jsonRes.status).toBe(403);

    const pdfRes = await invoke(
      "getRoundBriefPdf",
      authReq(outsider, { method: "GET", params: { id: round.id } }),
    );
    expect(pdfRes.status).toBe(403);

    const imageRes = await invoke(
      "getRoundBriefImage",
      authReq(outsider, { method: "GET", params: { id: round.id, n: "1" } }),
    );
    expect(imageRes.status).toBe(403);
  });

  test("organising-club coord and a participating pilot can read the brief (200)", async () => {
    const { round, orgCoord, participantUser } = await seedRoundWithBrief();

    const coordRes = await invoke(
      "getRoundBrief",
      authReq(orgCoord, { method: "GET", params: { id: round.id } }),
    );
    expect(coordRes.status).toBe(200);
    expect((coordRes.jsonBody as RoundBrief).briefersNotes).toBe("Do not publish this note");

    const pilotRes = await invoke(
      "getRoundBrief",
      authReq(participantUser, { method: "GET", params: { id: round.id } }),
    );
    expect(pilotRes.status).toBe(200);
  });
});

// ─── Candidate E — public pilot-club poisoning ────────────────────────────────

const E_ACTIVE_YEAR = 2026;

async function seedActiveSeason() {
  await writePublicJson("seasons.json", [
    { id: "season-e", year: E_ACTIVE_YEAR, active: true },
  ]);
}

describe("BOLA E — public pilot-club poisoning", () => {
  // SECURITY-AUDIT NOTE — this test DELIBERATELY REVERSES the former "public
  // pilot-club poisoning" guard, per issue #101 Decision 6 (ungated self-select;
  // "the selected club IS the season club"). Pre-#101 a self-declared currentClub
  // was kept OUT of the public index; now the ungated self-select is written to the
  // pilot's active-season seasonClubs entry, which the public index derives clubId
  // from — so it appears in pilots.json BY DESIGN. This is the same reversal the
  // plan documents for the meProfile.ts "Security: E" comment. The guard was LIFTED
  // ON PURPOSE, not broken. Why that is safe:
  //   • clubId in pilots.json is a NON-PII public field → the privacy scanner is
  //     unaffected (no PII crosses into the public container).
  //   • A self-declared club grants NO competition access: joining a team still
  //     requires a registered ClubTeam (addTeam), and registerSelf returns
  //     NO_TEAM_FOR_CLUB without one.
  //   • Coord PII visibility via getPilotById keys on currentClub, which a pilot
  //     could ALREADY self-set before #101 — pre-existing and unchanged here.
  test("(issue #101) self-selected club is written to the season club and now DOES appear in the public index — the old poisoning guard is intentionally lifted", async () => {
    await seedActiveSeason();
    const victimClub = await makeClub({ name: "Prestigious Club E" });
    const attacker = await makePilot({ firstName: "Mallory", lastName: "Imposter" });
    const { user: attackerUser } = await makeUser({
      roles: ["Pilot"],
      pilotId: attacker.id,
      emailVerified: true,
    });

    const res = await invoke(
      "updatePilot",
      authReq(attackerUser, {
        method: "PUT",
        params: { id: attacker.id },
        body: { currentClub: { id: victimClub.id, name: victimClub.name } },
      }),
    );
    expect(res.status).toBe(200);

    // Private self-pick is preserved (the documented pilotClubLock behaviour)…
    const stored = await readPrivateJson<{
      currentClub?: { id: string };
      seasonClubs: { seasonYear: number; clubId: string; clubName: string }[];
    }>(`pilots/${attacker.id}.json`);
    expect(stored?.currentClub?.id).toBe(victimClub.id);

    // …and the self-selected club is now recorded as the active-season season club —
    // this is the mechanism that drives the public-index change below.
    const seasonEntry = stored?.seasonClubs.find(
      (sc) => sc.seasonYear === E_ACTIVE_YEAR,
    );
    expect(seasonEntry).toEqual({
      seasonYear: E_ACTIVE_YEAR,
      clubId: victimClub.id,
      clubName: victimClub.name,
    });

    // …so the anonymously-readable public index now DOES show the selected club
    // (the issue #101 reversal — this assertion was previously toBeUndefined()).
    const publicIndex = await readPublicJson<PilotSummary[]>("pilots.json");
    const entry = publicIndex?.find((p) => p.id === attacker.id);
    expect(entry?.clubId).toBe(victimClub.id);
  });

  test("a verified active-season member IS shown under their club in the public index", async () => {
    await seedActiveSeason();
    const club = await makeClub({ name: "Verified Club E" });
    const member = await makePilot({ firstName: "Verity", lastName: "Member" });
    member.seasonClubs = [
      { seasonYear: E_ACTIVE_YEAR, clubId: club.id, clubName: club.name },
    ];
    member.currentClub = { id: club.id, name: club.name };
    await writePrivateJson(`pilots/${member.id}.json`, member);
    const { user: memberUser } = await makeUser({
      roles: ["Pilot"],
      pilotId: member.id,
      emailVerified: true,
    });

    const res = await invoke(
      "updatePilot",
      authReq(memberUser, {
        method: "PUT",
        params: { id: member.id },
        body: { helmetColour: "blue" },
      }),
    );
    expect(res.status).toBe(200);

    const publicIndex = await readPublicJson<PilotSummary[]>("pilots.json");
    const entry = publicIndex?.find((p) => p.id === member.id);
    expect(entry?.clubId).toBe(club.id);
  });
});
