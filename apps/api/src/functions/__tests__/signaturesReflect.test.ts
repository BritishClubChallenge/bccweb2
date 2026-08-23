// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { BriefSchema, RoundSchema, SignatureLedgerSchema } from "@bccweb/schemas";
import type { Round, RoundBrief, Signature, Team } from "@bccweb/types";

const telemetryMock = vi.hoisted(() => {
  const trackEvent = vi.fn();
  return { trackEvent, client: { trackEvent } };
});

vi.mock("../../lib/telemetry.js", () => ({
  getTelemetryClient: () => telemetryMock.client,
  setup: vi.fn(),
  resetForTests: vi.fn(),
}));

import { invokeQueue } from "../../__tests__/helpers/api.js";
import { getPrivateBlobClient } from "../../lib/blob.js";
import { readJson, writePrivateJson } from "../../lib/blobJson.js";
import { signaturePath } from "../../lib/signTofly/ledger.js";

import "../signaturesReflect.js";

const BRIEF_VERSION = 2;
const TEAM_ID = randomUUID();
const PILOT_ID = randomUUID();

function makeTeam(): Team {
  return {
    id: TEAM_ID,
    teamName: "Alpha",
    club: { id: randomUUID(), name: "Test Club" },
    score: 0,
    pilots: [
      {
        placeInTeam: 1,
        isScoring: true,
        status: "Filled",
        accountedFor: true,
        signToFly: false,
        noScore: false,
        pilotPoints: 0,
        pilotId: PILOT_ID,
        snapshot: { wingClass: "EN B", pilotRating: "Pilot" },
        flight: null,
      },
    ],
  };
}

function makeRound(roundId: string): Round {
  return {
    id: roundId,
    date: "2026-06-09",
    status: "BriefComplete",
    isLocked: false,
    maxTeams: 8,
    minimumScore: 0,
    site: { id: randomUUID(), name: "Milk Hill" },
    season: { year: 2026 },
    teams: [makeTeam()],
    brief: {
      version: BRIEF_VERSION,
      jsonPath: `round-briefs/${roundId}.json`,
      generatedAt: "2026-06-01T08:00:00.000Z",
    },
  };
}

function makeBrief(roundId: string): RoundBrief {
  return {
    roundId,
    generatedAt: "2026-06-01T08:00:00.000Z",
    date: "2026-06-09",
    siteName: "Milk Hill",
    version: BRIEF_VERSION,
    teams: [],
    windSpeedDirection: "W 10kt",
  };
}

function makeSignature(roundId: string): Signature {
  return {
    id: randomUUID(),
    roundId,
    teamId: TEAM_ID,
    place: 1,
    pilotId: PILOT_ID,
    userId: randomUUID(),
    signedAt: "2026-06-01T09:00:00.000Z",
    briefVersion: BRIEF_VERSION,
    briefHash: "brief-hash",
    wordingVersion: 1,
    wordingHash: "wording-hash",
    ip: null,
    userAgent: null,
    source: "pilot-self",
  };
}

async function seedReflectableRound(): Promise<{ readonly roundId: string }> {
  const roundId = randomUUID();
  const signature = makeSignature(roundId);
  await writePrivateJson(`rounds/${roundId}.json`, RoundSchema, makeRound(roundId));
  await writePrivateJson(`round-briefs/${roundId}.json`, BriefSchema, makeBrief(roundId));
  await writePrivateJson(
    signaturePath(roundId, signature.teamId, signature.place, signature.pilotId, BRIEF_VERSION),
    SignatureLedgerSchema,
    signature,
  );
  return { roundId };
}

async function readRound(roundId: string): Promise<Round> {
  return readJson(
    getPrivateBlobClient(`rounds/${roundId}.json`),
    RoundSchema,
    `rounds/${roundId}.json`,
  );
}

describe("signaturesReflect queue consumer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists sign-to-fly flags when a matching signature exists", async () => {
    // Given
    const { roundId } = await seedReflectableRound();

    // When
    await invokeQueue("signToFlyReflect", { roundId }, {});

    // Then
    const round = await readRound(roundId);
    expect(round.teams[0]?.pilots[0]?.signToFly).toBe(true);
  });

  it("rethrows reflect failures before the poison threshold", async () => {
    // Given
    const roundId = randomUUID();

    // When / Then
    await expect(
      invokeQueue("signToFlyReflect", { roundId }, { dequeueCount: 1 }),
    ).rejects.toBeTruthy();
  });

  it("swallows reflect failures at the poison threshold and emits telemetry", async () => {
    // Given
    const roundId = randomUUID();

    // When
    await invokeQueue("signToFlyReflect", { roundId }, { dequeueCount: 5 });

    // Then
    expect(telemetryMock.trackEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "signToFly.reflectFailed",
        properties: expect.objectContaining({ roundId }),
      }),
    );
  });

  it("telemeters poison messages and never throws for unparseable poison bodies", async () => {
    // Given
    const roundId = randomUUID();

    // When / Then
    await expect(invokeQueue("signToFlyReflectPoison", { roundId })).resolves.toBeUndefined();
    await expect(invokeQueue("signToFlyReflectPoison", "{bad")).resolves.toBeUndefined();
    expect(telemetryMock.trackEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "signToFly.reflectPoison",
        properties: expect.objectContaining({ roundId }),
      }),
    );
    expect(telemetryMock.trackEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: "signToFly.reflectPoison" }),
    );
  });
});
