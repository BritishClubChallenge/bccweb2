// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * Listing-count pins for the sign-to-fly resolution (issue #279, todo 6).
 *
 * The ledger module is wrapped in pass-through `vi.fn`s so every case hits the
 * REAL Azurite storage while we count how many listings each flow performs:
 *
 *   - (a) a successful self-unregister lists the pilot's occupancy exactly
 *     twice (pre-lease + in-lease) and never lists the whole round;
 *   - (b) a signed pilot is rejected 409 SIGNED_CONTACT_COORD after exactly
 *     one occupancy listing (the pre-lease check);
 *   - (c) the reflect job lists the round ledger exactly once per invocation.
 */
import { randomUUID } from "node:crypto";
import type { PilotSlot, Round, RoundBrief } from "@bccweb/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { writePrivateJson } from "../../__tests__/helpers/seed.js";
import { reflectRoundSignToFly } from "../../lib/signTofly/reflect.js";
import {
  listSignaturesForOccupancy,
  listSignaturesForRound,
  writeSignature,
} from "../../lib/signTofly/ledger.js";
import {
  makeSignature,
  seedRegistrationRound,
  unregister,
} from "./roundRegistration.testHelpers.js";
import "../roundRegistration.js";

vi.mock("../../lib/signTofly/ledger.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../lib/signTofly/ledger.js")
  >();
  return {
    ...actual,
    listSignaturesForRound: vi.fn(actual.listSignaturesForRound),
    listSignaturesForOccupancy: vi.fn(actual.listSignaturesForOccupancy),
  };
});

beforeEach(() => {
  vi.mocked(listSignaturesForRound).mockClear();
  vi.mocked(listSignaturesForOccupancy).mockClear();
});

describe("sign-to-fly listing counts", () => {
  it("successful self-unregister: 2 occupancy listings, 0 round listings", async () => {
    const ctx = await seedRegistrationRound({
      teamSlots: [{ placeInTeam: 1, pilotId: "self" }],
    });

    const res = await unregister(ctx);

    expect(res.status).toBe(200);
    expect(listSignaturesForOccupancy).toHaveBeenCalledTimes(2);
    expect(listSignaturesForRound).not.toHaveBeenCalled();
  });

  it("signed pilot: 409 SIGNED_CONTACT_COORD after exactly 1 occupancy listing", async () => {
    const ctx = await seedRegistrationRound({
      teamSlots: [{ placeInTeam: 1, pilotId: "self" }],
    });
    await writeSignature(makeSignature(ctx));

    const res = await unregister(ctx);

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe(
      "SIGNED_CONTACT_COORD"
    );
    expect(listSignaturesForOccupancy).toHaveBeenCalledTimes(1);
    expect(listSignaturesForRound).not.toHaveBeenCalled();
  });

  it("reflect on a BriefComplete round: exactly 1 round listing", async () => {
    const roundId = randomUUID();
    const round = makeReflectRound(roundId);
    await writePrivateJson(`rounds/${roundId}.json`, round);
    await writePrivateJson(
      `round-briefs/${roundId}.json`,
      makeReflectBrief(roundId)
    );

    await reflectRoundSignToFly(roundId);

    expect(listSignaturesForRound).toHaveBeenCalledTimes(1);
    expect(listSignaturesForOccupancy).not.toHaveBeenCalled();
  });
});

function makeReflectRound(roundId: string): Round {
  return {
    id: roundId,
    date: "2026-07-07",
    status: "BriefComplete",
    isLocked: true,
    maxTeams: 1,
    minimumScore: 0,
    site: { id: "site-1", name: "Test Site" },
    season: { year: 2026 },
    teams: [
      {
        id: "team-1",
        teamName: "Team One",
        club: { id: "club-1", name: "Club One" },
        score: 0,
        pilots: [makeReflectSlot()],
      },
    ],
  };
}

function makeReflectSlot(): PilotSlot {
  return {
    placeInTeam: 1,
    isScoring: true,
    status: "Filled",
    accountedFor: false,
    signToFly: false,
    noScore: false,
    pilotPoints: 0,
    pilotId: "pilot-1",
    snapshot: null,
    flight: null,
  };
}

function makeReflectBrief(roundId: string): RoundBrief & { version: number } {
  return {
    roundId,
    generatedAt: "2026-07-07T00:00:00.000Z",
    date: "2026-07-07",
    siteName: "Test Site",
    teams: [],
    version: 1,
  };
}
