// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import { BlockBlobClient } from "@azure/storage-blob";
import { BriefSchema, RoundSchema } from "@bccweb/schemas";
import { describe, expect, it, vi } from "vitest";
import type { PilotSlot, Round, RoundBrief, Signature } from "@bccweb/types";
import { getPrivateBlobClient } from "../../blob.js";
import { readJson, writePrivateJson } from "../../blobJson.js";
import { reflectRoundSignToFly } from "../reflect.js";
import { writeSignature } from "../ledger.js";

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
