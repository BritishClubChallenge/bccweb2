// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PilotSlot, Round } from "@bccweb/types";
import { makeAuthRequest, invoke } from "../../__tests__/helpers/api.js";
import { resetAllBuckets } from "../../lib/rateLimit.js";
import { makeUser, readPrivateJson, writePrivateJson } from "../../__tests__/helpers/seed.js";

vi.mock("../../lib/recompute.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/recompute.js")>();
  return { ...actual, recomputeSeason: vi.fn().mockResolvedValue(undefined) };
});

import { recomputeSeason } from "../../lib/recompute.js";
import "../roundsMutate.js";

interface SeedTeam {
  teamId: string;
  teamName: string;
  pilots: Array<{
    placeInTeam: number;
    status: PilotSlot["status"];
    pilotId: string | null;
    accountedFor: boolean;
    noScore?: boolean;
  }>;
}

async function seedRound(teams: SeedTeam[]): Promise<{ roundId: string; path: string }> {
  const roundId = randomUUID();
  const path = `rounds/${roundId}.json`;

  const round: Round = {
    id: roundId,
    date: "2026-06-09",
    status: "Locked",
    isLocked: true,
    maxTeams: 8,
    minimumScore: 0,
    site: { id: randomUUID(), name: "Milk Hill" },
    organisingClub: { id: randomUUID(), name: "Club A" },
    season: { year: 2026 },
    teams: teams.map((t) => ({
      id: t.teamId,
      teamName: t.teamName,
      club: { id: randomUUID(), name: t.teamName },
      score: 0,
      captainPilotId: null,
      pilots: t.pilots.map((p) => ({
        placeInTeam: p.placeInTeam,
        isScoring: true,
        status: p.status,
        accountedFor: p.accountedFor,
        signToFly: false,
        noScore: p.noScore ?? false,
        pilotPoints: 0,
        pilotId: p.pilotId,
        snapshot: null,
        flight: null,
      })),
    })),
  };

  await writePrivateJson(path, round);
  return { roundId, path };
}

/** Guards against `healingArray` silently dropping a malformed team/slot — see
 * completeRoundAccountedFor task notes. Every test MUST call this right after
 * seeding, before any behavior assertion. */
async function assertRoundTrip(path: string, teams: SeedTeam[]): Promise<void> {
  const stored = await readPrivateJson<Round>(path);
  expect(stored?.teams.length).toBe(teams.length);
  teams.forEach((t, i) => {
    expect(stored?.teams[i]?.pilots.length).toBe(t.pilots.length);
  });
}

async function complete(roundId: string, user: { id: string; email: string }) {
  return invoke(
    "completeRound",
    makeAuthRequest(user.id, user.email, {
      method: "POST",
      params: { id: roundId },
    }),
  );
}

describe("completeRound — PILOTS_NOT_ACCOUNTED_FOR gate", () => {
  beforeEach(() => {
    resetAllBuckets();
    vi.mocked(recomputeSeason).mockClear();
  });

  it("A: single unaccounted Filled slot -> 409, round left untouched", async () => {
    const teamId = randomUUID();
    const teamName = "Alpha";
    const pilotId = randomUUID();
    const teams: SeedTeam[] = [
      {
        teamId,
        teamName,
        pilots: [
          { placeInTeam: 1, status: "Filled", pilotId, accountedFor: false },
        ],
      },
    ];
    const { roundId, path } = await seedRound(teams);
    await assertRoundTrip(path, teams);
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await complete(roundId, user);

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("PILOTS_NOT_ACCOUNTED_FOR");
    expect((res.jsonBody as { detail: string }).detail).toBe(
      `Unaccounted-for slots: ${teamName} #1 (${pilotId})`,
    );

    const stored = await readPrivateJson<Round>(path);
    expect(stored?.status).toBe("Locked");
    expect(stored?.isLocked).toBe(true);
    expect(stored?.scoring).toBeUndefined();
    expect(vi.mocked(recomputeSeason)).not.toHaveBeenCalled();
  });

  it("B: two unaccounted Filled slots across two teams -> 409, detail lists both in order", async () => {
    const teamAId = randomUUID();
    const teamAName = "Alpha";
    const pilotAId = randomUUID();
    const teamBId = randomUUID();
    const teamBName = "Bravo";
    const pilotBId = randomUUID();
    const teams: SeedTeam[] = [
      {
        teamId: teamAId,
        teamName: teamAName,
        pilots: [
          { placeInTeam: 1, status: "Filled", pilotId: pilotAId, accountedFor: false },
        ],
      },
      {
        teamId: teamBId,
        teamName: teamBName,
        pilots: [
          { placeInTeam: 1, status: "Filled", pilotId: pilotBId, accountedFor: false },
        ],
      },
    ];
    const { roundId, path } = await seedRound(teams);
    await assertRoundTrip(path, teams);
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await complete(roundId, user);

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("PILOTS_NOT_ACCOUNTED_FOR");
    expect((res.jsonBody as { detail: string }).detail).toBe(
      `Unaccounted-for slots: ${teamAName} #1 (${pilotAId}); ${teamBName} #1 (${pilotBId})`,
    );
  });

  it("C: every Filled slot accountedFor -> 200, Complete, recomputeSeason fired for the round's year", async () => {
    const teamId = randomUUID();
    const pilotId = randomUUID();
    const teams: SeedTeam[] = [
      {
        teamId,
        teamName: "Alpha",
        pilots: [
          { placeInTeam: 1, status: "Filled", pilotId, accountedFor: true },
        ],
      },
    ];
    const { roundId, path } = await seedRound(teams);
    await assertRoundTrip(path, teams);
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await complete(roundId, user);

    expect(res.status).toBe(200);
    expect((res.jsonBody as { status: string }).status).toBe("Complete");
    // AC2: the happy path still fires the best-effort post-response season recompute.
    expect(vi.mocked(recomputeSeason)).toHaveBeenCalledWith(2026);
  });

  it("D: Empty slot alongside accounted-for Filled slot never blocks -> 200", async () => {
    const teamId = randomUUID();
    const pilotId = randomUUID();
    const teams: SeedTeam[] = [
      {
        teamId,
        teamName: "Alpha",
        pilots: [
          { placeInTeam: 1, status: "Filled", pilotId, accountedFor: true },
          { placeInTeam: 2, status: "Empty", pilotId: null, accountedFor: false },
        ],
      },
    ];
    const { roundId, path } = await seedRound(teams);
    await assertRoundTrip(path, teams);
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await complete(roundId, user);

    expect(res.status).toBe(200);
  });

  it("E: noScore Filled slot still blocks when unaccounted -> 409", async () => {
    const teamId = randomUUID();
    const teamName = "Alpha";
    const pilotId = randomUUID();
    const teams: SeedTeam[] = [
      {
        teamId,
        teamName,
        pilots: [
          {
            placeInTeam: 1,
            status: "Filled",
            pilotId,
            accountedFor: false,
            noScore: true,
          },
        ],
      },
    ];
    const { roundId, path } = await seedRound(teams);
    await assertRoundTrip(path, teams);
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await complete(roundId, user);

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("PILOTS_NOT_ACCOUNTED_FOR");
  });

  it("F: Filled slot with pilotId null still blocks, renders (null)", async () => {
    const teamId = randomUUID();
    const teams: SeedTeam[] = [
      {
        teamId,
        teamName: "Alpha",
        pilots: [
          { placeInTeam: 1, status: "Filled", pilotId: null, accountedFor: false },
        ],
      },
    ];
    const { roundId, path } = await seedRound(teams);
    await assertRoundTrip(path, teams);
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await complete(roundId, user);

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("PILOTS_NOT_ACCOUNTED_FOR");
    expect((res.jsonBody as { detail: string }).detail).toContain("(null)");
  });

  it("G: round with no teams at all -> 200, nothing to gate on", async () => {
    const teams: SeedTeam[] = [];
    const { roundId, path } = await seedRound(teams);
    await assertRoundTrip(path, teams);
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await complete(roundId, user);

    expect(res.status).toBe(200);
  });
});
