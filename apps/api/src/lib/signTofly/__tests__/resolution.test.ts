// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PilotSlot, Round, RoundBrief, Signature, Team } from "@bccweb/types";
import {
  currentBriefVersion,
  readOccupancySignatureLedger,
  readRoundSignatureLedger,
  signatureLedgerView,
  type Occupancy,
} from "../resolution.js";
import {
  legacySignaturePath,
  overrideSignaturePath,
  signaturePath,
  writeSignature,
  writeSignatureToPath,
} from "../ledger.js";

// ─── Pure rule cases (no storage access) ─────────────────────────────────────

describe("signatureLedgerView / SignToFlyResolution (pure rules)", () => {
  it("isSigned is true when the occupancy's latest signature matches the brief version", () => {
    const view = signatureLedgerView([
      makeSignature({ teamId: "team-1", place: 1, pilotId: "pilot-1", briefVersion: 2 }),
    ]);
    const resolution = view.resolveAgainst(makeBrief({ version: 2 }));
    expect(resolution.isSigned({ teamId: "team-1", place: 1, pilotId: "pilot-1" })).toBe(true);
  });

  it("isSigned is false when the latest signature predates the brief version", () => {
    const view = signatureLedgerView([
      makeSignature({ teamId: "team-1", place: 1, pilotId: "pilot-1", briefVersion: 1 }),
    ]);
    const resolution = view.resolveAgainst(makeBrief({ version: 2 }));
    expect(resolution.isSigned({ teamId: "team-1", place: 1, pilotId: "pilot-1" })).toBe(false);
  });

  it("isSigned is false for an occupancy with no signatures at all", () => {
    const view = signatureLedgerView([
      makeSignature({ teamId: "team-1", place: 1, pilotId: "pilot-1", briefVersion: 2 }),
    ]);
    const resolution = view.resolveAgainst(makeBrief({ version: 2 }));
    expect(resolution.isSigned({ teamId: "team-1", place: 1, pilotId: "pilot-9" })).toBe(false);
    expect(resolution.isSigned({ teamId: "team-1", place: 2, pilotId: "pilot-1" })).toBe(false);
    expect(resolution.isSigned({ teamId: "team-2", place: 1, pilotId: "pilot-1" })).toBe(false);
  });

  it("hasSignedAnyVersion is true for any versioned signature and false when only a legacy null-version signature exists", () => {
    const versioned: Occupancy = { teamId: "team-1", place: 1, pilotId: "pilot-1" };
    const legacyOnly: Occupancy = { teamId: "team-1", place: 2, pilotId: "pilot-2" };
    const absent: Occupancy = { teamId: "team-1", place: 3, pilotId: "pilot-3" };
    const view = signatureLedgerView([
      makeSignature({ ...versioned, briefVersion: 1 }),
      makeSignature({ ...legacyOnly, briefVersion: null, source: "legacy-migrated" }),
    ]);
    expect(view.hasSignedAnyVersion(versioned)).toBe(true);
    expect(view.hasSignedAnyVersion(legacyOnly)).toBe(false);
    expect(view.hasSignedAnyVersion(absent)).toBe(false);
  });

  it("a higher briefVersion wins regardless of input order and signedAt", () => {
    const occupancy: Occupancy = { teamId: "team-1", place: 1, pilotId: "pilot-1" };
    const v1Later = makeSignature({
      ...occupancy,
      id: "sig-v1",
      briefVersion: 1,
      signedAt: "2026-07-07T10:00:00.000Z",
    });
    const v2Earlier = makeSignature({
      ...occupancy,
      id: "sig-v2",
      briefVersion: 2,
      signedAt: "2026-07-07T09:00:00.000Z",
    });

    // The pilot signed v1 LATER in time than v2 (override rewrite); v2 still wins.
    for (const order of [
      [v1Later, v2Earlier],
      [v2Earlier, v1Later],
    ]) {
      const view = signatureLedgerView(order);
      expect(view.resolveAgainst(makeBrief({ version: 2 })).isSigned(occupancy)).toBe(true);
      expect(view.resolveAgainst(makeBrief({ version: 1 })).isSigned(occupancy)).toBe(false);
      expect(view.hasSignedAnyVersion(occupancy)).toBe(true);
    }
  });

  it("equal versions break by signedAt, a null signedAt losing to any timestamped one, under every permutation", () => {
    const occupancy: Occupancy = { teamId: "team-1", place: 1, pilotId: "pilot-1" };
    // Two coord-override signatures for the same occupancy at the same version.
    const nullSignedAt = makeSignature({
      ...occupancy,
      id: "sig-null",
      briefVersion: 2,
      signedAt: null,
      source: "coord-override",
    });
    const timestamped = makeSignature({
      ...occupancy,
      id: "sig-stamped",
      briefVersion: 2,
      signedAt: "2026-07-07T09:00:00.000Z",
      source: "coord-override",
    });

    for (const order of [
      [nullSignedAt, timestamped],
      [timestamped, nullSignedAt],
    ]) {
      const view = signatureLedgerView(order);
      expect(view.resolveAgainst(makeBrief({ version: 2 })).isSigned(occupancy)).toBe(true);
      expect(view.resolveAgainst(makeBrief({ version: 3 })).isSigned(occupancy)).toBe(false);
      expect(view.hasSignedAnyVersion(occupancy)).toBe(true);
    }
  });

  it("equal version and equal signedAt break by id, giving identical results under every permutation", () => {
    const occupancy: Occupancy = { teamId: "team-1", place: 1, pilotId: "pilot-1" };
    // Identical signedAt; the id step is not observable through the public API
    // (predicates read only the version), so order-independence is the assertion.
    const a = makeSignature({
      ...occupancy,
      id: "sig-a",
      briefVersion: 2,
      signedAt: "2026-07-07T09:00:00.000Z",
    });
    const b = makeSignature({
      ...occupancy,
      id: "sig-b",
      briefVersion: 2,
      signedAt: "2026-07-07T09:00:00.000Z",
    });

    for (const order of [
      [a, b],
      [b, a],
    ]) {
      const view = signatureLedgerView(order);
      expect(view.resolveAgainst(makeBrief({ version: 2 })).isSigned(occupancy)).toBe(true);
      expect(view.resolveAgainst(makeBrief({ version: 1 })).isSigned(occupancy)).toBe(false);
      expect(view.hasSignedAnyVersion(occupancy)).toBe(true);
    }
  });

  it("is order-independent across original, reversed and a fixed permutation for isSigned and applyTo", () => {
    const round = makeRound([
      makeSlot({ placeInTeam: 1, pilotId: "pilot-1", signToFly: false }),
      makeSlot({ placeInTeam: 2, pilotId: "pilot-2", signToFly: true }),
      makeSlot({ placeInTeam: 3, pilotId: "pilot-3", signToFly: true }),
    ]);
    const brief = makeBrief({ version: 2 });
    const occupancies: Occupancy[] = [
      { teamId: "team-1", place: 1, pilotId: "pilot-1" },
      { teamId: "team-1", place: 2, pilotId: "pilot-2" },
      { teamId: "team-1", place: 3, pilotId: "pilot-3" },
    ];
    const signatures = [
      makeSignature({ teamId: "team-1", place: 1, pilotId: "pilot-1", briefVersion: 2 }),
      makeSignature({ teamId: "team-1", place: 2, pilotId: "pilot-2", briefVersion: 1 }),
      makeSignature({ teamId: "team-1", place: 2, pilotId: "pilot-2", briefVersion: null }),
      makeSignature({ teamId: "team-1", place: 3, pilotId: "pilot-3", briefVersion: 1 }),
      makeSignature({
        teamId: "team-1",
        place: 3,
        pilotId: "pilot-3",
        briefVersion: 2,
        signedAt: "2026-07-07T11:00:00.000Z",
      }),
    ];

    const permutations = [
      signatures,
      [...signatures].reverse(),
      [signatures[2], signatures[4], signatures[0], signatures[3], signatures[1]],
    ];
    const expected = permutations.map((order) => {
      const view = signatureLedgerView(order);
      const resolution = view.resolveAgainst(brief);
      const trial = makeRound([
        makeSlot({ placeInTeam: 1, pilotId: "pilot-1", signToFly: false }),
        makeSlot({ placeInTeam: 2, pilotId: "pilot-2", signToFly: true }),
        makeSlot({ placeInTeam: 3, pilotId: "pilot-3", signToFly: true }),
      ]);
      const changed = resolution.applyTo(trial);
      return {
        signed: occupancies.map((occupancy) => resolution.isSigned(occupancy)),
        anyVersion: occupancies.map((occupancy) => view.hasSignedAnyVersion(occupancy)),
        changed,
        flags: slotFlags(trial),
      };
    });

    // Sanity: the expected outcome itself is the correct rule outcome.
    expect(expected[0]).toEqual({
      signed: [true, false, true],
      anyVersion: [true, true, true],
      changed: true,
      flags: [true, false, true],
    });
    expect(expected[1]).toEqual(expected[0]);
    expect(expected[2]).toEqual(expected[0]);
    // And the shared round fixture was never mutated by the permutations.
    expect(slotFlags(round)).toEqual([false, true, true]);
  });

  it("recognizes a returning pilot's own earlier signature even though a different pilot signed the same slot more recently in between (regression: double roster swap)", () => {
    // Given: pilot-1 signed the slot at v1 (earlier), pilot-2 later occupied and
    // signed the SAME slot at v1 (later signedAt), and pilot-1 has now returned.
    const occupancy: Occupancy = { teamId: "team-1", place: 1, pilotId: "pilot-1" };
    const view = signatureLedgerView([
      makeSignature({ ...occupancy, briefVersion: 1, signedAt: "2026-07-07T09:00:00.000Z" }),
      makeSignature({
        teamId: "team-1",
        place: 1,
        pilotId: "pilot-2",
        briefVersion: 1,
        signedAt: "2026-07-07T10:00:00.000Z",
      }),
    ]);
    const resolution = view.resolveAgainst(makeBrief({ version: 1 }));

    // Then: pilot-1's OWN v1 signature is recognized; pilot-2's later one cannot shadow it.
    expect(resolution.isSigned(occupancy)).toBe(true);
    expect(view.hasSignedAnyVersion(occupancy)).toBe(true);

    const round = makeRound([makeSlot({ placeInTeam: 1, pilotId: "pilot-1", signToFly: false })]);
    expect(resolution.applyTo(round)).toBe(true);
    expect(slotFlags(round)).toEqual([true]);
  });

  it("currentBriefVersion defaults an undefined brief version to 1", () => {
    expect(currentBriefVersion(makeBrief())).toBe(1);
    expect(currentBriefVersion(makeBrief({ version: 3 }))).toBe(3);
  });

  it("resolveAgainst treats a brief without a stored version as version 1", () => {
    const occupancy: Occupancy = { teamId: "team-1", place: 1, pilotId: "pilot-1" };
    const view = signatureLedgerView([makeSignature({ ...occupancy, briefVersion: 1 })]);
    const resolution = view.resolveAgainst(makeBrief());
    expect(resolution.briefVersion).toBe(1);
    expect(resolution.isSigned(occupancy)).toBe(true);
  });

  it("unsignedSlots returns entries in teams-array then slots-array order", () => {
    const round = makeRoundWithTeams([
      {
        id: "team-1",
        teamName: "Team One",
        slots: [
          makeSlot({ placeInTeam: 1, pilotId: "pilot-1" }),
          makeSlot({ placeInTeam: 2, pilotId: "pilot-2" }),
        ],
      },
      {
        id: "team-2",
        teamName: "Team Two",
        slots: [
          makeSlot({ placeInTeam: 1, pilotId: "pilot-3" }),
          makeSlot({ placeInTeam: 2, pilotId: "pilot-4" }),
        ],
      },
    ]);
    const signatures = [
      makeSignature({ teamId: "team-2", place: 1, pilotId: "pilot-3", briefVersion: 1 }),
    ];
    const resolution = signatureLedgerView(signatures).resolveAgainst(makeBrief({ version: 1 }));

    expect(resolution.unsignedSlots(round)).toEqual([
      { teamId: "team-1", teamName: "Team One", placeInTeam: 1, pilotId: "pilot-1" },
      { teamId: "team-1", teamName: "Team One", placeInTeam: 2, pilotId: "pilot-2" },
      { teamId: "team-2", teamName: "Team Two", placeInTeam: 2, pilotId: "pilot-4" },
    ]);
  });

  it("unsignedSlots skips Empty slots and null or empty-string pilotIds", () => {
    const round = makeRound([
      makeSlot({ placeInTeam: 1, pilotId: null, status: "Empty" }),
      makeSlot({ placeInTeam: 2, pilotId: "pilot-1", status: "Empty" }),
      makeSlot({ placeInTeam: 3, pilotId: null, status: "Filled" }),
      makeSlot({ placeInTeam: 4, pilotId: "", status: "Filled" }),
      makeSlot({ placeInTeam: 5, pilotId: "pilot-5", status: "Filled" }),
    ]);
    const resolution = signatureLedgerView([]).resolveAgainst(makeBrief({ version: 1 }));

    expect(resolution.unsignedSlots(round)).toEqual([
      { teamId: "team-1", teamName: "Team One", placeInTeam: 5, pilotId: "pilot-5" },
    ]);
  });

  it("unsignedSlots counts a slot signed only by a former occupant as unsigned", () => {
    const round = makeRound([makeSlot({ placeInTeam: 1, pilotId: "pilot-new", status: "Filled" })]);
    const signatures = [
      makeSignature({ teamId: "team-1", place: 1, pilotId: "pilot-old", briefVersion: 1 }),
    ];
    const resolution = signatureLedgerView(signatures).resolveAgainst(makeBrief({ version: 1 }));

    expect(resolution.unsignedSlots(round)).toEqual([
      { teamId: "team-1", teamName: "Team One", placeInTeam: 1, pilotId: "pilot-new" },
    ]);
  });

  it("applyTo materializes from current, stale and absent signatures and returns true on change", () => {
    const round = makeRound([
      makeSlot({ placeInTeam: 1, signToFly: false }),
      makeSlot({ placeInTeam: 2, signToFly: true }),
      makeSlot({ placeInTeam: 3, signToFly: true }),
      makeSlot({ placeInTeam: 4, signToFly: false }),
    ]);
    const signatures = [
      makeSignature({ teamId: "team-1", place: 1, briefVersion: 2 }),
      makeSignature({ teamId: "team-1", place: 2, briefVersion: 1 }),
      makeSignature({ teamId: "team-1", place: 4, briefVersion: 2, source: "coord-override" }),
    ];
    const resolution = signatureLedgerView(signatures).resolveAgainst(makeBrief({ version: 2 }));

    expect(resolution.applyTo(round)).toBe(true);
    expect(slotFlags(round)).toEqual([true, false, false, true]);
  });

  it("applyTo returns false when the round is already materialized", () => {
    const round = makeRound([
      makeSlot({ placeInTeam: 1, signToFly: true }),
      makeSlot({ placeInTeam: 2, signToFly: false }),
      makeSlot({ placeInTeam: 3, signToFly: false }),
    ]);
    const signatures = [
      makeSignature({ teamId: "team-1", place: 1, briefVersion: 2 }),
      makeSignature({ teamId: "team-1", place: 2, briefVersion: 1 }),
    ];
    const resolution = signatureLedgerView(signatures).resolveAgainst(makeBrief({ version: 2 }));

    expect(resolution.applyTo(round)).toBe(false);
    expect(slotFlags(round)).toEqual([true, false, false]);
  });

  it("applyTo clears every slot when the signature list is empty", () => {
    const round = makeRound([
      makeSlot({ placeInTeam: 1, signToFly: true }),
      makeSlot({ placeInTeam: 2, signToFly: true }),
    ]);
    const resolution = signatureLedgerView([]).resolveAgainst(makeBrief({ version: 1 }));

    expect(resolution.applyTo(round)).toBe(true);
    expect(slotFlags(round)).toEqual([false, false]);
  });

  it("applyTo sets a non-Filled slot with a signed pilot to true (status ignored)", () => {
    const round = makeRound([
      makeSlot({ placeInTeam: 1, pilotId: "pilot-1", status: "Empty", signToFly: false }),
    ]);
    const signatures = [makeSignature({ teamId: "team-1", place: 1, pilotId: "pilot-1", briefVersion: 1 })];
    const resolution = signatureLedgerView(signatures).resolveAgainst(makeBrief({ version: 1 }));

    expect(resolution.applyTo(round)).toBe(true);
    expect(slotFlags(round)).toEqual([true]);
  });

  it("applyTo sets a null-pilot slot to false", () => {
    const round = makeRound([makeSlot({ placeInTeam: 1, pilotId: null, status: "Empty", signToFly: true })]);
    const resolution = signatureLedgerView([]).resolveAgainst(makeBrief({ version: 1 }));

    expect(resolution.applyTo(round)).toBe(true);
    expect(slotFlags(round)).toEqual([false]);
  });

  it("demoteSuperseded demotes a superseded true flag and counts it", () => {
    const round = makeRound([
      makeSlot({ placeInTeam: 1, pilotId: "pilot-1", signToFly: true }),
      makeSlot({ placeInTeam: 2, pilotId: "pilot-2", signToFly: false }),
      makeSlot({ placeInTeam: 3, pilotId: "pilot-3", signToFly: true }),
    ]);
    const signatures = [
      makeSignature({ teamId: "team-1", place: 1, pilotId: "pilot-1", briefVersion: 1 }),
      makeSignature({ teamId: "team-1", place: 2, pilotId: "pilot-2", briefVersion: 1 }),
      makeSignature({ teamId: "team-1", place: 3, pilotId: "pilot-3", briefVersion: 2 }),
    ];
    const resolution = signatureLedgerView(signatures).resolveAgainst(makeBrief({ version: 2 }));

    expect(resolution.demoteSuperseded(round)).toBe(1);
    expect(slotFlags(round)).toEqual([false, false, true]);
  });

  it("demoteSuperseded leaves a superseded false flag false and does not count it", () => {
    const round = makeRound([makeSlot({ placeInTeam: 1, pilotId: "pilot-1", signToFly: false })]);
    const signatures = [makeSignature({ teamId: "team-1", place: 1, pilotId: "pilot-1", briefVersion: 1 })];
    const resolution = signatureLedgerView(signatures).resolveAgainst(makeBrief({ version: 2 }));

    expect(resolution.demoteSuperseded(round)).toBe(0);
    expect(slotFlags(round)).toEqual([false]);
  });

  it("demoteSuperseded does not touch a legacy-only slot (no versioned entry) even when its flag is true (U4)", () => {
    const round = makeRound([
      makeSlot({ placeInTeam: 1, pilotId: "pilot-1", signToFly: true }),
      makeSlot({ placeInTeam: 2, pilotId: "pilot-2", signToFly: true }),
    ]);
    const signatures = [
      makeSignature({
        teamId: "team-1",
        place: 1,
        pilotId: "pilot-1",
        briefVersion: null,
        source: "legacy-migrated",
      }),
    ];
    // Slot 2 has NO signature at all; slot 1 only a legacy null-version one.
    const resolution = signatureLedgerView(signatures).resolveAgainst(makeBrief({ version: 2 }));

    expect(resolution.demoteSuperseded(round)).toBe(0);
    expect(slotFlags(round)).toEqual([true, true]);
  });

  it("demoteSuperseded leaves a null-pilot slot with a true flag untouched", () => {
    const round = makeRound([makeSlot({ placeInTeam: 1, pilotId: null, status: "Empty", signToFly: true })]);
    const resolution = signatureLedgerView([]).resolveAgainst(makeBrief({ version: 2 }));

    expect(resolution.demoteSuperseded(round)).toBe(0);
    expect(slotFlags(round)).toEqual([true]);
  });

  it("demoteSuperseded counts each demoted slot once when two slots share a team and place (S1)", () => {
    const round = makeRound([
      makeSlot({ placeInTeam: 1, pilotId: null, status: "Empty", signToFly: false }),
      makeSlot({ placeInTeam: 1, pilotId: "pilot-1", status: "Filled", signToFly: true }),
    ]);
    const signatures = [makeSignature({ teamId: "team-1", place: 1, pilotId: "pilot-1", briefVersion: 1 })];
    const resolution = signatureLedgerView(signatures).resolveAgainst(makeBrief({ version: 2 }));

    expect(resolution.demoteSuperseded(round)).toBe(1);
    expect(slotFlags(round)).toEqual([false, false]);
  });
});

// ─── Loaders (Azurite-backed) ────────────────────────────────────────────────

describe("loaders", () => {
  it("readRoundSignatureLedger reflects written signatures", async () => {
    const roundId = randomUUID();
    await writeSignature(makeSignature({ roundId, teamId: "team-1", place: 1, pilotId: "pilot-1", briefVersion: 1 }));
    await writeSignatureToPath(
      makeSignature({
        id: "sig-override",
        roundId,
        teamId: "team-1",
        place: 2,
        pilotId: "pilot-2",
        briefVersion: 2,
        source: "coord-override",
      }),
      overrideSignaturePath(roundId, "team-1", 2, "pilot-2", 2, "abc123"),
    );

    const view = await readRoundSignatureLedger(roundId);
    const occupancy1: Occupancy = { teamId: "team-1", place: 1, pilotId: "pilot-1" };
    const occupancy2: Occupancy = { teamId: "team-1", place: 2, pilotId: "pilot-2" };
    expect(view.hasSignedAnyVersion(occupancy1)).toBe(true);
    expect(view.hasSignedAnyVersion(occupancy2)).toBe(true);
    expect(view.resolveAgainst(makeBrief({ version: 1 })).isSigned(occupancy1)).toBe(true);
    expect(view.resolveAgainst(makeBrief({ version: 2 })).isSigned(occupancy2)).toBe(true);
    expect(view.hasSignedAnyVersion({ teamId: "team-1", place: 9, pilotId: "pilot-9" })).toBe(false);
  });

  it("readOccupancySignatureLedger reports hasSignedAnyVersion for v1..v3 signed by this pilot", async () => {
    const roundId = randomUUID();
    const occupancy: Occupancy = { teamId: "team-1", place: 1, pilotId: "pilot-1" };
    for (const briefVersion of [1, 2, 3]) {
      await writeSignature(
        makeSignature({ id: `sig-v${briefVersion}`, roundId, ...occupancy, briefVersion }),
      );
    }

    const view = await readOccupancySignatureLedger(roundId, occupancy);
    expect(view.hasSignedAnyVersion(occupancy)).toBe(true);
    expect(view.resolveAgainst(makeBrief({ version: 3 })).isSigned(occupancy)).toBe(true);
    expect(view.resolveAgainst(makeBrief({ version: 2 })).isSigned(occupancy)).toBe(false);
  });

  it("readOccupancySignatureLedger is false when only a legacy blob exists for the occupancy", async () => {
    const roundId = randomUUID();
    const occupancy: Occupancy = { teamId: "team-1", place: 1, pilotId: "pilot-1" };
    await writeSignatureToPath(
      makeSignature({ roundId, ...occupancy, briefVersion: null, source: "legacy-migrated" }),
      legacySignaturePath(roundId, occupancy.teamId, occupancy.place, occupancy.pilotId),
    );

    const view = await readOccupancySignatureLedger(roundId, occupancy);
    expect(view.hasSignedAnyVersion(occupancy)).toBe(false);
    expect(view.resolveAgainst(makeBrief({ version: 1 })).isSigned(occupancy)).toBe(false);
  });

  it("readOccupancySignatureLedger is false when only another pilot signed the slot", async () => {
    const roundId = randomUUID();
    const occupancy: Occupancy = { teamId: "team-1", place: 1, pilotId: "pilot-1" };
    await writeSignature(
      makeSignature({ roundId, teamId: "team-1", place: 1, pilotId: "pilot-2", briefVersion: 1 }),
    );

    const view = await readOccupancySignatureLedger(roundId, occupancy);
    expect(view.hasSignedAnyVersion(occupancy)).toBe(false);
  });

  it("readOccupancySignatureLedger is false when a blob at this pilot's path carries a foreign payload pilotId", async () => {
    const roundId = randomUUID();
    const occupancy: Occupancy = { teamId: "team-1", place: 1, pilotId: "pilot-1" };
    // The blob sits at pilot-1's path but the PAYLOAD names a different pilot:
    // the payload fields own the key, so this pilot's occupancy stays unsigned.
    await writeSignatureToPath(
      makeSignature({ roundId, teamId: "team-1", place: 1, pilotId: "pilot-foreign", briefVersion: 1 }),
      signaturePath(roundId, occupancy.teamId, occupancy.place, occupancy.pilotId, 1),
    );

    const view = await readOccupancySignatureLedger(roundId, occupancy);
    expect(view.hasSignedAnyVersion(occupancy)).toBe(false);
    expect(view.resolveAgainst(makeBrief({ version: 1 })).isSigned(occupancy)).toBe(false);
  });
});

// ─── Helpers (copied from reflect.test.ts) ───────────────────────────────────

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

function makeRoundWithTeams(teams: Array<{ id: string; teamName: string; slots: PilotSlot[] }>): Round {
  const built: Team[] = teams.map((team) => ({
    id: team.id,
    teamName: team.teamName,
    club: { id: `club-${team.id}`, name: `Club ${team.id}` },
    score: 0,
    pilots: team.slots,
  }));
  return makeRound([], { teams: built });
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
