// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import type { HttpResponseInit } from "@azure/functions";
import type {
  Flight,
  FrozenRoundStatus,
  Round,
  RoundBrief,
  RoundStatus,
  Site,
  Team,
} from "@bccweb/types";
import { makeAuthRequest, invoke } from "../../__tests__/helpers/api.js";
import { resetAllBuckets } from "../../lib/rateLimit.js";
import {
  makeUser,
  makeRound,
  makePilot,
  makeSite,
  readPrivateJson,
  writePrivateJson,
} from "../../__tests__/helpers/seed.js";
import "../roundsMutate.js";

// Two visibly different hills. `makeSite` cannot seed W3W values (SeedSiteOptions
// is { id, name, clubId } only) and `makeRound` re-creates sites/{siteId}.json,
// clobbering anything written beforehand — so the round's embedded site sub-object
// is patched AFTER makeRound returns, which is what updateRound actually reads.
const HILL_A = {
  name: "Hill A",
  parkingW3W: "alpha.alpha.alpha",
  briefingW3W: "alpha.bravo.alpha",
  takeOffW3W: "alpha.charlie.alpha",
} as const;

const HILL_B = {
  name: "Hill B",
  parkingW3W: "bravo.alpha.bravo",
  briefingW3W: "bravo.bravo.bravo",
  takeOffW3W: "bravo.charlie.bravo",
} as const;

function frozenDetail(reason: string): string {
  return `Cannot change the round's date, site, organising club or capacity while ${reason}`;
}

function errorBody(res: HttpResponseInit): { code?: string; detail?: string } {
  return (res.jsonBody ?? {}) as { code?: string; detail?: string };
}

async function readRound(id: string): Promise<Round> {
  const round = await readPrivateJson<Round>(`rounds/${id}.json`);
  if (!round) throw new Error(`Round ${id} missing`);
  return round;
}

async function readBrief(id: string): Promise<RoundBrief> {
  const brief = await readPrivateJson<RoundBrief>(`round-briefs/${id}.json`);
  if (!brief) throw new Error(`Brief for round ${id} missing`);
  return brief;
}

async function seedFixtureRound(
  status: RoundStatus,
  overrides: { clubId?: string; siteName?: string; teams?: Round["teams"] } = {},
): Promise<{ round: Round; clubId: string }> {
  const clubId = overrides.clubId ?? randomUUID();

  const created = await makeRound({
    organisingClubId: clubId,
    organisingClubName: "Test Club",
    siteName: overrides.siteName ?? "Test Site",
    ...(overrides.teams !== undefined && { teams: overrides.teams }),
  });

  // Force the status directly — the real transition handlers require a full
  // roster snapshot these fixtures deliberately skip.
  const round = await readRound(created.id);
  round.status = status;
  // Production sets isLocked at Locked and NOWHERE else: completeRound clears it
  // (roundsMutate.ts:1457, asserted by roundLifecycle.integration.test.ts:199), so
  // a Complete round carries isLocked === false. Anything wider here would let the
  // current `r.isLocked` guard catch Complete and hide the hole under test.
  round.isLocked = status === "Locked";
  await writePrivateJson(`rounds/${created.id}.json`, round);

  return { round, clubId };
}

function updateRound(
  user: { id: string; email: string },
  roundId: string,
  body: Record<string, unknown>,
): Promise<HttpResponseInit> {
  return invoke(
    "updateRound",
    makeAuthRequest(user.id, user.email, {
      method: "PUT",
      params: { id: roundId },
      body,
    }),
  );
}

// The exact rosterFrozenReason() outputs (packages/types/src/status.ts:24-34) —
// pinned as literals so the "names its reason" behaviour cannot silently drift.
const FROZEN_CASES: ReadonlyArray<readonly [FrozenRoundStatus, string]> = [
  ["BriefComplete", "the brief is complete (reopen the brief first)"],
  ["Locked", "the round is locked"],
  ["Complete", "the round is complete"],
];

describe("updateRound — fixture edits frozen with the roster (issue 272)", () => {
  beforeEach(() => resetAllBuckets());

  it.each(FROZEN_CASES)(
    "%s: 409 CONFLICT naming its reason, maxTeams unchanged",
    async (status, reason) => {
      const { round } = await seedFixtureRound(status);
      const { user } = await makeUser({ roles: ["Admin"] });

      const res = await updateRound(user, round.id, { maxTeams: 4 });

      expect(res.status).toBe(409);
      expect(errorBody(res).code).toBe("CONFLICT");
      expect(errorBody(res).detail).toBe(frozenDetail(reason));
      const after = await readRound(round.id);
      expect(after.maxTeams).toBe(round.maxTeams);
    },
  );

  it.each(["Proposed", "Confirmed"] as const)(
    "%s: 200, maxTeams updated — the gate must not be over-broad",
    async (status) => {
      const { round } = await seedFixtureRound(status);
      const { user } = await makeUser({ roles: ["Admin"] });

      const res = await updateRound(user, round.id, { maxTeams: 4 });

      expect(res.status).toBe(200);
      const after = await readRound(round.id);
      expect(after.maxTeams).toBe(4);
    },
  );

  it("Cancelled: 409 ROUND_CANCELLED, not the generic frozen CONFLICT", async () => {
    // Cancelled is roster-frozen too, so the cancelled check must keep running
    // BEFORE the frozen gate or callers lose the "uncancel it first" signal.
    const { round } = await seedFixtureRound("Cancelled");
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await updateRound(user, round.id, { maxTeams: 4 });

    expect(res.status).toBe(409);
    expect(errorBody(res).code).toBe("ROUND_CANCELLED");
    const after = await readRound(round.id);
    expect(after.maxTeams).toBe(round.maxTeams);
  });
});

describe("updateRound — round and brief must describe the same hill (issue 272)", () => {
  beforeEach(() => resetAllBuckets());

  it("BriefComplete: site change rejected, round site still matches the brief", async () => {
    const { round, clubId } = await seedFixtureRound("BriefComplete", {
      siteName: HILL_A.name,
    });

    // Patch the round's embedded site AFTER makeRound (which overwrites the site
    // blob); updateRound reads and rewrites this sub-object.
    round.site = { id: round.site.id, ...HILL_A };
    await writePrivateJson(`rounds/${round.id}.json`, round);

    const brief: RoundBrief = {
      roundId: round.id,
      generatedAt: "2026-06-01T08:00:00.000Z",
      date: round.date,
      siteName: HILL_A.name,
      parkingW3W: HILL_A.parkingW3W,
      briefingW3W: HILL_A.briefingW3W,
      takeOffW3W: HILL_A.takeOffW3W,
      teams: [],
    };
    await writePrivateJson(`round-briefs/${round.id}.json`, brief);

    // Site B must be a real, readable blob: updateRound 409s with "Site not found"
    // when it is missing (roundsMutate.ts:385-392), which would be a false green.
    const createdB = await makeSite({ name: HILL_B.name, clubId });
    const siteB: Site = { ...createdB, ...HILL_B };
    await writePrivateJson(`sites/${siteB.id}.json`, siteB);

    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await updateRound(user, round.id, { siteId: siteB.id });

    const after = await readRound(round.id);
    const briefAfter = await readBrief(round.id);

    // Soft assertions: a leaked site change fails BOTH the status code and the
    // round/brief comparison, and the desync is the point of this test — it must
    // not be masked by whichever assertion happens to run first.
    expect.soft(res.status).toBe(409);
    expect.soft(after.site.id).toBe(round.site.id);

    // What this guards: the round and the brief pilots signed against must never
    // describe different hills. parkingW3W/briefingW3W/takeOffW3W are
    // MATERIAL_BRIEF_FIELDS (packages/schemas/src/brief.ts:155-157), so a change
    // leaking into the round while the brief keeps the old values silently
    // invalidates every prior sign-to-fly signature with no version bump.
    expect.soft(after.site.name).toBe(HILL_A.name);
    expect.soft(briefAfter.siteName).toBe(HILL_A.name);
    expect.soft(after.site.name).toBe(briefAfter.siteName);

    expect.soft(after.site.parkingW3W).toBe(HILL_A.parkingW3W);
    expect.soft(briefAfter.parkingW3W).toBe(HILL_A.parkingW3W);
    expect.soft(after.site.parkingW3W).toBe(briefAfter.parkingW3W);

    expect.soft(after.site.briefingW3W).toBe(HILL_A.briefingW3W);
    expect.soft(briefAfter.briefingW3W).toBe(HILL_A.briefingW3W);
    expect.soft(after.site.briefingW3W).toBe(briefAfter.briefingW3W);

    expect.soft(after.site.takeOffW3W).toBe(HILL_A.takeOffW3W);
    expect.soft(briefAfter.takeOffW3W).toBe(HILL_A.takeOffW3W);
    expect.soft(after.site.takeOffW3W).toBe(briefAfter.takeOffW3W);
  });
});

describe("updateRound — date change at Complete (issue 272)", () => {
  beforeEach(() => resetAllBuckets());

  it("Complete: date change rejected, flight date-validation left intact", async () => {
    const clubId = randomUUID();
    const pilot = await makePilot({ clubId });

    const flight: Flight = {
      id: randomUUID(),
      distance: 42,
      scoringType: "XC",
      score: 0,
      wingFactor: 1,
      isManualLog: false,
      validation: { date: "valid" },
      sanityFlags: ["IGC_DATE_MISMATCH"],
    };

    const team: Team = {
      id: randomUUID(),
      teamName: "Alpha",
      club: { id: clubId, name: "Test Club" },
      score: 0,
      captainPilotId: null,
      pilots: [
        {
          placeInTeam: 1,
          pilotId: pilot.id,
          isScoring: true,
          status: "Filled",
          accountedFor: true,
          signToFly: false,
          noScore: false,
          pilotPoints: 0,
          snapshot: null,
          flight,
        },
      ],
    };

    const { round } = await seedFixtureRound("Complete", { clubId, teams: [team] });
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await updateRound(user, round.id, { date: "2025-07-20" });

    // A date move on a scored round strips `validation.date` and the
    // IGC_DATE_MISMATCH sanity flag off every flight — silently un-flagging
    // evidence that was already reviewed. Rejecting the edit is the only fix.
    expect(res.status).toBe(409);
    const after = await readRound(round.id);
    const afterFlight = after.teams[0].pilots[0].flight;
    expect(after.date).toBe(round.date);
    expect(afterFlight?.validation).toEqual({ date: "valid" });
    expect(afterFlight?.sanityFlags).toEqual(["IGC_DATE_MISMATCH"]);
  });
});
