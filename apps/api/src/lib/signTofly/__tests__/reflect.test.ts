// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import { BlockBlobClient } from "@azure/storage-blob";
import { BriefSchema, RoundSchema } from "@bccweb/schemas";
import { describe, expect, it, vi } from "vitest";
import type { PilotSlot, Round, RoundBrief, Signature } from "@bccweb/types";
import { getPrivateBlobClient } from "../../blob.js";
import { readJson, writePrivateJson } from "../../blobJson.js";
import { materializeSignToFly, reflectRoundSignToFly } from "../reflect.js";
import { writeSignature } from "../ledger.js";

describe("materializeSignToFly", () => {
  it("sets slots from current, stale, absent, and override signatures", () => {
    // Given: a current brief and mixed slot/signature states.
    const round = makeRound([
      makeSlot({ placeInTeam: 1, signToFly: false }),
      makeSlot({ placeInTeam: 2, signToFly: true }),
      makeSlot({ placeInTeam: 3, signToFly: true }),
      makeSlot({ placeInTeam: 4, signToFly: false }),
    ]);
    const brief = makeBrief({ version: 2 });
    const signatures = [
      makeSignature({ teamId: "team-1", place: 1, briefVersion: 2 }),
      makeSignature({ teamId: "team-1", place: 2, briefVersion: 1 }),
      makeSignature({
        teamId: "team-1",
        place: 4,
        briefVersion: 2,
        source: "coord-override",
      }),
    ];

    // When: the materialized flags are reflected onto the round.
    const changed = materializeSignToFly(round, brief, signatures);

    // Then: each slot matches only the latest signature's brief version.
    expect(changed).toBe(true);
    expect(slotFlags(round)).toEqual([true, false, false, true]);
  });

  it("uses the max non-null briefVersion and ignores legacy null versions", () => {
    // Given: legacy/null and older entries exist before a current signature.
    const round = makeRound([
      makeSlot({ placeInTeam: 1, signToFly: false }),
      makeSlot({ placeInTeam: 2, signToFly: true }),
    ]);
    const brief = makeBrief({ version: 3 });
    const signatures = [
      makeSignature({ teamId: "team-1", place: 1, briefVersion: null }),
      makeSignature({ teamId: "team-1", place: 1, briefVersion: 1 }),
      makeSignature({ teamId: "team-1", place: 1, briefVersion: 3 }),
      makeSignature({ teamId: "team-1", place: 2, briefVersion: null }),
    ];

    // When: the latest version map is materialized.
    const changed = materializeSignToFly(round, brief, signatures);

    // Then: max non-null version wins, while null-only signatures behave absent.
    expect(changed).toBe(true);
    expect(slotFlags(round)).toEqual([true, false]);
  });

  it("defaults an undefined brief version to one", () => {
    // Given: a brief without a stored version and a version-one signature.
    const round = makeRound([makeSlot({ placeInTeam: 1, signToFly: false })]);
    const brief = makeBrief();
    const signatures = [makeSignature({ teamId: "team-1", place: 1, briefVersion: 1 })];

    // When: the brief version is omitted.
    const changed = materializeSignToFly(round, brief, signatures);

    // Then: version one is treated as current.
    expect(changed).toBe(true);
    expect(slotFlags(round)).toEqual([true]);
  });

  it("clears every slot when the signature list is empty", () => {
    // Given: slots currently marked as signed but no signatures are present.
    const round = makeRound([
      makeSlot({ placeInTeam: 1, signToFly: true }),
      makeSlot({ placeInTeam: 2, signToFly: true }),
    ]);
    const brief = makeBrief({ version: 1 });

    // When: no signature can support any slot.
    const changed = materializeSignToFly(round, brief, []);

    // Then: all flags are materialized to false.
    expect(changed).toBe(true);
    expect(slotFlags(round)).toEqual([false, false]);
  });

  it("returns false when all slots already match the signature materialization", () => {
    // Given: slots already match current, stale, and absent signature outcomes.
    const round = makeRound([
      makeSlot({ placeInTeam: 1, signToFly: true }),
      makeSlot({ placeInTeam: 2, signToFly: false }),
      makeSlot({ placeInTeam: 3, signToFly: false }),
    ]);
    const brief = makeBrief({ version: 2 });
    const signatures = [
      makeSignature({ teamId: "team-1", place: 1, briefVersion: 2 }),
      makeSignature({ teamId: "team-1", place: 2, briefVersion: 1 }),
    ];

    // When: materialization is repeated.
    const changed = materializeSignToFly(round, brief, signatures);

    // Then: no mutation is reported and values stay the same.
    expect(changed).toBe(false);
    expect(slotFlags(round)).toEqual([true, false, false]);
  });

  it("a returning pilot's own earlier signature is recognized again, even though a different pilot signed the same slot more recently in between (regression: double roster swap)", () => {
    // Given: pilot-1 signed the slot at v1 (earlier), pilot-2 later
    // occupied and signed the SAME slot at v1 (later signedAt), and
    // pilot-1 has now returned to the slot.
    const round = makeRound([makeSlot({ placeInTeam: 1, pilotId: "pilot-1", signToFly: false })]);
    const brief = makeBrief({ version: 1 });
    const signatures = [
      makeSignature({ teamId: "team-1", place: 1, pilotId: "pilot-1", briefVersion: 1, signedAt: "2026-07-07T09:00:00.000Z" }),
      makeSignature({ teamId: "team-1", place: 1, pilotId: "pilot-2", briefVersion: 1, signedAt: "2026-07-07T10:00:00.000Z" }),
    ];

    // When: the round is materialized with pilot-1 back in the slot.
    const changed = materializeSignToFly(round, brief, signatures);

    // Then: pilot-1's OWN v1 signature is recognized, even though
    // pilot-2's signature for the same slot has a later signedAt.
    expect(changed).toBe(true);
    expect(slotFlags(round)).toEqual([true]);
  });
});

describe("reflectRoundSignToFly", () => {
  it("persists signToFly true for a current signature", async () => {
    // Given: a BriefComplete round, current brief, and matching signature blob.
    const roundId = randomUUID();
    const round = makeRound([makeSlot({ signToFly: false })], { id: roundId });
    await seedRound(round);
    await seedBrief(makeBrief({ roundId, version: 1 }));
    await writeSignature(makeSignature({ roundId, briefVersion: 1 }));

    // When: the round-level reflector replays the ledger.
    await reflectRoundSignToFly(roundId);

    // Then: the persisted round blob carries the materialized flag.
    expect(slotFlags(await readRound(roundId))).toEqual([true]);
  });

  it("persists signToFly false when only stale signatures exist", async () => {
    // Given: a v2 brief and only a stale v1 signature for a true slot.
    const roundId = randomUUID();
    const round = makeRound([makeSlot({ signToFly: true })], { id: roundId });
    await seedRound(round);
    await seedBrief(makeBrief({ roundId, version: 2 }));
    await writeSignature(makeSignature({ roundId, briefVersion: 1 }));

    // When: the ledger is materialized against the current brief inside the lease.
    await reflectRoundSignToFly(roundId);

    // Then: stale signatures do not keep persisted sign-to-fly flags alive.
    expect(slotFlags(await readRound(roundId))).toEqual([false]);
  });

  it("silently no-ops without a write when the round is not BriefComplete", async () => {
    // Given: a Locked round with an existing current signature.
    const roundId = randomUUID();
    const round = makeRound([makeSlot({ signToFly: false })], {
      id: roundId,
      status: "Locked",
    });
    await seedRound(round);
    await seedBrief(makeBrief({ roundId, version: 1 }));
    await writeSignature(makeSignature({ roundId, briefVersion: 1 }));
    const uploadSpy = vi.spyOn(BlockBlobClient.prototype, "upload");

    // When: reflection runs for a non-BriefComplete round.
    try {
      await reflectRoundSignToFly(roundId);

      // Then: it does not throw, mutate flags, or upload a new round blob.
      expect(uploadSpy).not.toHaveBeenCalled();
      expect(slotFlags(await readRound(roundId))).toEqual([false]);
    } finally {
      uploadSpy.mockRestore();
    }
  });

  it("silently no-ops when the brief blob is missing", async () => {
    // Given: a BriefComplete round has no round-briefs/{id}.json blob.
    const roundId = randomUUID();
    const round = makeRound([makeSlot({ signToFly: false })], { id: roundId });
    await seedRound(round);
    await writeSignature(makeSignature({ roundId, briefVersion: 1 }));

    // When/Then: the missing brief is not swallowed as success for mutation.
    await expect(reflectRoundSignToFly(roundId)).resolves.toBeUndefined();
    expect(slotFlags(await readRound(roundId))).toEqual([false]);
  });

  it("retries lease contention when concurrent reflect jobs race", async () => {
    // Given: one current signature and many jobs for the same round blob.
    const roundId = randomUUID();
    const round = makeRound([makeSlot({ signToFly: false })], { id: roundId });
    await seedRound(round);
    await seedBrief(makeBrief({ roundId, version: 1 }));
    await writeSignature(makeSignature({ roundId, briefVersion: 1 }));

    // When: twenty-five reflections run concurrently.
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, () => reflectRoundSignToFly(roundId)),
    );

    // Then: no lease conflict escapes and persisted state is correct.
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(0);
    expect(slotFlags(await readRound(roundId))).toEqual([true]);
  });

  it("propagates a missing round so the queue consumer can retry", async () => {
    // Given: no rounds/{id}.json blob exists.
    const roundId = randomUUID();

    // When/Then: missing round acquisition/read errors are not swallowed.
    await expect(reflectRoundSignToFly(roundId)).rejects.toMatchObject({ statusCode: 404 });
  });
});

function makeRound(pilots: PilotSlot[], overrides: Partial<Round> = {}): Round {
  return {
    id: "round-1",
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
        pilots,
      },
    ],
    ...overrides,
  };
}

function makeSlot(overrides: Partial<PilotSlot>): PilotSlot {
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
    ...overrides,
  };
}

function makeBrief(overrides: Partial<RoundBrief & { version?: number }> = {}): RoundBrief & { version?: number } {
  return {
    roundId: "round-1",
    generatedAt: "2026-07-07T00:00:00.000Z",
    date: "2026-07-07",
    siteName: "Test Site",
    teams: [],
    ...overrides,
  };
}

function makeSignature(overrides: Partial<Signature>): Signature {
  return {
    id: "signature-1",
    roundId: "round-1",
    teamId: "team-1",
    place: 1,
    pilotId: "pilot-1",
    userId: "user-1",
    signedAt: "2026-07-07T00:00:00.000Z",
    briefVersion: 1,
    briefHash: "brief-hash",
    wordingVersion: 1,
    wordingHash: "wording-hash",
    ip: "203.0.113.1",
    userAgent: "vitest",
    source: "pilot-self",
    ...overrides,
  };
}

function slotFlags(round: Round): boolean[] {
  return round.teams.flatMap((team) => team.pilots.map((slot) => slot.signToFly));
}

async function seedRound(round: Round): Promise<void> {
  await writePrivateJson(`rounds/${round.id}.json`, RoundSchema, round);
}

async function seedBrief(brief: RoundBrief & { version?: number }): Promise<void> {
  await writePrivateJson(`round-briefs/${brief.roundId}.json`, BriefSchema, brief);
}

async function readRound(roundId: string): Promise<Round> {
  const path = `rounds/${roundId}.json`;
  return readJson(getPrivateBlobClient(path), RoundSchema, path);
}
