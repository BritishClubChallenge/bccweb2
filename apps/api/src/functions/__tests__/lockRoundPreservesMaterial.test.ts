// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * T8 — lock preserves the FROZEN sign-to-fly material hash.
 *
 * Exercises `lockRound` (BriefComplete→Locked) via the registered API handler
 * (Vitest, NOT real HTTP). After T7 freezes `brief.hash` at brief-complete, the
 * lock transition may refresh ONLY non-material parts of the brief (the team
 * roster + PureTrack/site/date/club echoes). Every safety-material field and the
 * freeze identity (version/versionHistory/hash) MUST survive byte-identical so
 * `computeBriefHash(brief) === brief.hash` still holds after lock.
 *
 * Covers the plan's T8 acceptance checklist:
 *  - lock keeps briefer-authored material (briefersNotes + briefingTime) AND the
 *    frozen hash is byte-stable post-lock.
 *  - teams are repopulated with pilot snapshots after lock.
 *  - B5: EVERY field in the single `MATERIAL_BRIEF_FIELDS` declaration survives
 *    the lock byte-identical (proves the preserve-list cannot diverge).
 *  - tampered material (computeBriefHash !== hash) ABORTS the lock (round stays
 *    BriefComplete) AND emits the `brief.lockHashMismatch` diagnostic.
 *  - hard brief/round write failures leave the round BriefComplete; a round-write
 *    failure also restores the exact pre-lock brief.
 *  - a PDF-generation failure is best-effort: the round still reaches Locked.
 */

import { randomUUID } from "node:crypto";
import type { Pilot, Round, RoundBrief, Season } from "@bccweb/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke, makeAuthRequest } from "../../__tests__/helpers/api.js";
import {
  makeClub,
  makeConfig,
  makePilot,
  makeSite,
  makeUser,
  readPrivateJson,
  writePrivateJson,
  writePublicJson,
} from "../../__tests__/helpers/seed.js";
import { computeBriefHash, MATERIAL_BRIEF_FIELDS } from "../../lib/signTofly/briefVersion.js";
import { writeSignature } from "../../lib/signTofly/ledger.js";
import * as pureTrack from "../../lib/puretrack.js";

// ─── External-service mocks (deterministic + no real I/O) ─────────────────────
const pdfMock = vi.hoisted(() => ({
  generateBriefPdf: vi.fn(),
}));
vi.mock("../../lib/pdf.js", () => ({
  generateBriefPdf: pdfMock.generateBriefPdf,
}));

const emailMock = vi.hoisted(() => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  briefHtmlBody: vi.fn().mockReturnValue("<p>brief</p>"),
  briefPlainText: vi.fn().mockReturnValue("brief"),
}));
vi.mock("../../lib/email.js", () => ({
  sendEmail: emailMock.sendEmail,
  briefHtmlBody: emailMock.briefHtmlBody,
  briefPlainText: emailMock.briefPlainText,
}));

vi.mock("../../lib/queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queue.js")>()),
  enqueueBriefPdf: vi.fn(),
  enqueuePureTrackGroupJob: vi.fn(),
}));

import { enqueueBriefPdf, enqueuePureTrackGroupJob } from "../../lib/queue.js";

// Telemetry spy. setup.ts does NOT mock telemetry; getTelemetryClient() returns
// undefined in tests. The stub client is a Proxy so any method (e.g. trackEvent
// on a blob heal) is a safe no-op while `trackTrace` is the spy we assert on.
const telemetryMock = vi.hoisted(() => {
  const trackTrace = vi.fn();
  const target: Record<string | symbol, unknown> = { trackTrace };
  const client = new Proxy(target, {
    get(proxyTarget, prop) {
      if (prop in proxyTarget) return proxyTarget[prop];
      const stub = vi.fn();
      proxyTarget[prop] = stub;
      return stub;
    },
  });
  return { trackTrace, client };
});
vi.mock("../../lib/telemetry.js", () => ({
  getTelemetryClient: () => telemetryMock.client,
  setup: vi.fn(),
  resetForTests: vi.fn(),
}));

// Force a HARD failure of the brief-JSON write to prove lock does not advance to
// Locked without it. Gated by a flag so seeding (which never touches round-briefs
// through blobJson.writePrivateJson) is unaffected; only flipped around lock().
const blobJsonControl = vi.hoisted(() => ({
  failBriefWrite: false,
  failRoundWrite: false,
}));
vi.mock("../../lib/blobJson.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/blobJson.js")>();
  return {
    ...actual,
    writePrivateJson: vi.fn(
      (path: string, schema: unknown, data: unknown, leaseId?: string, opts?: unknown) => {
        if (blobJsonControl.failBriefWrite && path.startsWith("round-briefs/")) {
          return Promise.reject(new Error("simulated brief JSON write failure"));
        }
        if (blobJsonControl.failRoundWrite && path.startsWith("rounds/")) {
          return Promise.reject(new Error("simulated round JSON write failure"));
        }
        return (
          actual.writePrivateJson as unknown as (...args: unknown[]) => Promise<void>
        )(path, schema, data, leaseId, opts);
      },
    ),
  };
});

// Override default 15s renewIntervalMs which hits the leaseDurationSec*500 guard.
// withRoundAndBriefLease (used by lock now) is left REAL via the actual spread.
vi.mock("../../lib/blob.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/blob.js")>();
  return {
    ...actual,
    withLeaseRenewing: <T>(
      path: string,
      fn: (leaseId: string) => Promise<T>,
      opts: Parameters<typeof actual.withLeaseRenewing>[2] = {},
    ) => actual.withLeaseRenewing(path, fn, { renewIntervalMs: 1_000, ...opts }),
    withPrivateLeaseRenewing: <T>(
      path: string,
      fn: (leaseId: string) => Promise<T>,
      opts: Parameters<typeof actual.withPrivateLeaseRenewing>[2] = {},
    ) => actual.withPrivateLeaseRenewing(path, fn, { renewIntervalMs: 1_000, ...opts }),
  };
});

// Register handlers (side-effectful import)
import "../roundsMutate.js";

interface Ctx {
  roundId: string;
  teamId: string;
  pilotId: string;
  adminUserId: string;
  adminEmail: string;
  clubId: string;
  siteId: string;
  year: number;
}

async function seedBriefCompleteRound(): Promise<Ctx> {
  const year = 3000 + Math.floor(Math.random() * 6_000);
  const club = await makeClub({ id: randomUUID(), name: "Lock Test Club" });
  const site = await makeSite({ id: randomUUID(), name: "Milk Hill", clubId: club.id });
  await makeConfig({});
  const pilot = await makePilot({
    id: randomUUID(),
    firstName: "Lock",
    lastName: "Pilot",
    clubId: club.id,
  });
  // Patch pilot with snapshot-able fields so lock can take a snapshot.
  const patched: Pilot = {
    ...pilot,
    bhpaNumber: 12345,
    helmetColour: "white",
    harnessType: "pod",
    harnessColour: "black",
    wingManufacturer: { id: randomUUID(), name: "Ozone" },
    wingModel: "Delta",
    wingColours: "blue",
    emergencyContactName: "Emergency Contact",
    emergencyPhoneNumber: "07111222333",
    medicalInfo: "none",
    person: { ...pilot.person, phoneNumber: "07999000111" },
  };
  await writePrivateJson(`pilots/${pilot.id}.json`, patched);
  const { user: admin } = await makeUser({ roles: ["Admin"], clubId: club.id });

  const teamId = randomUUID();
  const roundId = randomUUID();
  const round: Round = {
    id: roundId,
    date: `${year}-06-09`,
    status: "BriefComplete",
    isLocked: false,
    maxTeams: 8,
    minimumScore: 0,
    site: {
      id: site.id,
      name: "Milk Hill",
      parkingW3W: "filled.count.soap",
      briefingW3W: "brief.count.soap",
      takeOffW3W: "takeoff.count.soap",
    },
    organisingClub: { id: club.id, name: "Lock Test Club" },
    season: { year },
    teams: [
      {
        id: teamId,
        teamName: "Alpha",
        club: { id: club.id, name: "Lock Test Club" },
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
            snapshot: { wingClass: "EN B", pilotRating: "Pilot" },
            flight: null,
          },
        ],
      },
    ],
  };
  await writePrivateJson(`rounds/${roundId}.json`, round);
  await writePublicJson(`seasons/${year}.json`, {
    id: `season-${year}`,
    year,
    active: true,
    rounds: [roundId],
    leagueTable: [],
  } satisfies Season);
  await writePublicJson("rounds.json", [
    {
      id: roundId,
      date: round.date,
      siteId: site.id,
      siteName: "Milk Hill",
      status: round.status,
      seasonYear: year,
    },
  ]);

  // Sign the seeded Filled slot at the current brief version so lockRound's
  // completeness gate sees a schema-valid signature at the canonical path. The
  // gate reads every blob under signatures/{roundId}/, so writeSignature is
  // required; the brief hash here must match the value the test later writes
  // via frozen(buildBrief()).
  const seededBrief = {
    roundId,
    version: 1,
    generatedAt: "2026-06-09T08:00:00.000Z",
    date: `${year}-06-09`,
    siteName: "Milk Hill",
    parkingW3W: "filled.count.soap",
    briefingW3W: "brief.count.soap",
    takeOffW3W: "takeoff.count.soap",
    briefingTime: "10:00",
    checkInByTime: "19:00",
    landByTime: "18:00",
    windSpeedDirection: "NW 15kt",
    teams: [],
  };
  const seededBriefHash = computeBriefHash(seededBrief);
  await writeSignature({
    id: randomUUID(),
    roundId,
    teamId,
    place: 1,
    pilotId: pilot.id,
    userId: admin.id,
    signedAt: new Date().toISOString(),
    briefVersion: 1,
    briefHash: seededBriefHash,
    wordingVersion: 1,
    wordingHash: "lock-preserves-material-wording-hash",
    ip: "203.0.113.4",
    userAgent: "lock-preserves-material-fixture",
    source: "pilot-self",
  });

  return {
    roundId,
    teamId,
    pilotId: pilot.id,
    adminUserId: admin.id,
    adminEmail: admin.email,
    clubId: club.id,
    siteId: site.id,
    year,
  };
}

/** A schema-valid brief carrying material + cosmetic fields, but NO hash yet. */
function buildBrief(ctx: Ctx, over: Partial<RoundBrief> = {}): RoundBrief {
  return {
    roundId: ctx.roundId,
    generatedAt: "2026-06-09T08:00:00.000Z",
    date: `${ctx.year}-06-09`,
    siteName: "Milk Hill",
    parkingW3W: "filled.count.soap",
    briefingW3W: "brief.count.soap",
    takeOffW3W: "takeoff.count.soap",
    briefingTime: "10:00",
    checkInByTime: "19:00",
    landByTime: "18:00",
    windSpeedDirection: "NW 15kt",
    version: 1,
    teams: [],
    ...over,
  };
}

/** Freeze the material hash exactly as brief-complete (T7) does. */
function frozen(brief: RoundBrief): RoundBrief {
  return { ...brief, hash: computeBriefHash(brief) };
}

function seedBrief(ctx: Ctx, brief: RoundBrief): Promise<void> {
  return writePrivateJson(`round-briefs/${ctx.roundId}.json`, brief);
}

function lock(ctx: Ctx) {
  return invoke(
    "lockRound",
    makeAuthRequest(ctx.adminUserId, ctx.adminEmail, {
      method: "POST",
      params: { id: ctx.roundId },
    }),
  );
}

describe("lockRound preserves the frozen material hash while refreshing teams (T8)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    blobJsonControl.failBriefWrite = false;
    blobJsonControl.failRoundWrite = false;
    pdfMock.generateBriefPdf.mockResolvedValue(Buffer.from("%PDF-1.4 lock-test"));
    vi.mocked(enqueueBriefPdf).mockResolvedValue(undefined);
    vi.mocked(enqueuePureTrackGroupJob).mockResolvedValue(undefined);
    telemetryMock.trackTrace.mockClear();
  });

  afterEach(() => {
    blobJsonControl.failBriefWrite = false;
    blobJsonControl.failRoundWrite = false;
    vi.restoreAllMocks();
  });

  it("keeps briefer-authored material + a byte-stable frozen hash, and repopulates team snapshots", async () => {
    const ctx = await seedBriefCompleteRound();
    const createPureTrackGroupsSpy = vi.spyOn(pureTrack, "createPureTrackGroups");
    const brief = frozen(
      buildBrief(ctx, {
        briefersNotes: "Authored briefer notes",
        briefingTime: "09:30",
        briefer: { name: "Alice", bhpaCoachLevel: "SeniorCoach" },
      }),
    );
    const frozenHash = brief.hash!;
    await seedBrief(ctx, brief);

    vi.mocked(enqueuePureTrackGroupJob).mockImplementationOnce(async (job) => {
      const committed = await readPrivateJson<Round>(`rounds/${job.roundId}.json`);
      expect(committed?.status).toBe("Locked");
      expect(committed?.pureTrack).toMatchObject({ status: "pending", attemptId: job.attemptId });
    });
    const res = await lock(ctx);
    expect(res.status).toBe(200);

    const after = (await readPrivateJson<RoundBrief>(`round-briefs/${ctx.roundId}.json`))!;
    // Material survives byte-identical.
    expect(after.briefersNotes).toBe("Authored briefer notes");
    expect(after.briefingTime).toBe("09:30");
    // Cosmetic briefer survives.
    expect(after.briefer).toEqual({ name: "Alice", bhpaCoachLevel: "SeniorCoach" });
    // The frozen hash is byte-stable AND still consistent with the material.
    expect(after.hash).toBe(frozenHash);
    expect(computeBriefHash(after)).toBe(after.hash);
    // Non-material derived: teams repopulated WITH a snapshot.
    expect(after.teams).toHaveLength(1);
    expect(after.teams[0]?.pilots?.[0]?.pilotId).toBe(ctx.pilotId);
    expect(after.teams[0]?.pilots?.[0]?.snapshot).toBeTruthy();

    const round = (await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`))!;
    expect(round.status).toBe("Locked");
    expect(round.pureTrack?.status).toBe("pending");
    expect(round.pureTrack?.attemptId).toBeTruthy();
    expect(enqueuePureTrackGroupJob).toHaveBeenCalledTimes(1);
    expect(enqueuePureTrackGroupJob).toHaveBeenCalledWith({
      roundId: ctx.roundId,
      attemptId: round.pureTrack?.attemptId,
    });
    expect(enqueueBriefPdf).toHaveBeenCalledTimes(1);
    expect(createPureTrackGroupsSpy).not.toHaveBeenCalled();
  });

  it("B5: EVERY field in the single MATERIAL_BRIEF_FIELDS declaration survives lock byte-identical", async () => {
    const ctx = await seedBriefCompleteRound();
    // A distinctive value for every material field — driven from the SAME
    // MATERIAL_BRIEF_FIELDS source the merge preserves from, so a missing field
    // in the merge would drop here (and break the hash assertion below).
    const material: Partial<RoundBrief> = {
      briefingTime: "11:11",
      checkInByTime: "12:12",
      landByTime: "13:13",
      windSpeedDirection: "NE 22kt",
      directionOfFlight: "ESE",
      expectedLandingArea: "Bottom field by the barn",
      airspaceAndHazards: "Danger area D123 active 0900-1700",
      NOTAMs: "NOTAM ABC123 obstacle lit",
      BENO_LineDescription: "BENO line along the north ridge",
      briefersNotes: "Distinct authored briefer notes",
      frequencyMhz: 143.925,
      parkingW3W: "park.three.words",
      briefingW3W: "brief.three.words",
      takeOffW3W: "takeoff.three.words",
      imagePaths: ["images/one.jpg", "images/two.jpg"],
    };
    const brief = frozen(buildBrief(ctx, material));
    const frozenHash = brief.hash!;
    await seedBrief(ctx, brief);

    const res = await lock(ctx);
    expect(res.status).toBe(200);

    const after = (await readPrivateJson<RoundBrief>(`round-briefs/${ctx.roundId}.json`))!;
    for (const field of MATERIAL_BRIEF_FIELDS) {
      expect(after[field]).toEqual(brief[field]);
    }
    expect(after.hash).toBe(frozenHash);
    expect(computeBriefHash(after)).toBe(after.hash);
  });

  it("ABORTS the lock when material was tampered (computeBriefHash !== hash) and emits brief.lockHashMismatch", async () => {
    const ctx = await seedBriefCompleteRound();
    // hash set but does NOT match the material content → tamper signal.
    const tampered = {
      ...buildBrief(ctx, { briefersNotes: "Genuine notes" }),
      hash: "TAMPERED-HASH-DOES-NOT-MATCH-MATERIAL",
    };
    await seedBrief(ctx, tampered);

    const res = await lock(ctx);

    expect(res.status).toBeGreaterThanOrEqual(400);
    // Round must NOT advance — stays BriefComplete.
    const round = (await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`))!;
    expect(round.status).toBe("BriefComplete");
    // Diagnostic emitted (never a silent failure).
    const mismatchTraces = telemetryMock.trackTrace.mock.calls.filter(
      ([arg]) => (arg as { message?: string }).message === "brief.lockHashMismatch",
    );
    expect(mismatchTraces).toHaveLength(1);
    expect((mismatchTraces[0][0] as { properties?: { roundId?: string } }).properties?.roundId).toBe(ctx.roundId);
  });

  it("hard-fails (non-2xx) and leaves the round BriefComplete when the brief-JSON write throws", async () => {
    const ctx = await seedBriefCompleteRound();
    await seedBrief(ctx, frozen(buildBrief(ctx, { briefersNotes: "notes" })));

    blobJsonControl.failBriefWrite = true;
    const res = await lock(ctx);
    blobJsonControl.failBriefWrite = false;

    expect(res.status).toBeGreaterThanOrEqual(500);
    const round = (await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`))!;
    expect(round.status).toBe("BriefComplete");
    expect(round.isLocked).toBe(false);
  });

  it("restores the pre-lock brief when the Locked round write throws", async () => {
    const ctx = await seedBriefCompleteRound();
    const before = frozen(buildBrief(ctx, { briefersNotes: "original notes" }));
    await seedBrief(ctx, before);

    blobJsonControl.failRoundWrite = true;
    const res = await lock(ctx);
    blobJsonControl.failRoundWrite = false;

    expect(res.status).toBeGreaterThanOrEqual(500);
    const round = (await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`))!;
    expect(round.status).toBe("BriefComplete");
    expect(round.isLocked).toBe(false);
    const brief = (await readPrivateJson<RoundBrief>(`round-briefs/${ctx.roundId}.json`))!;
    expect(brief).toEqual(before);
  });

  it("is best-effort on PDF queue failure: enqueue failure still reaches Locked", async () => {
    const ctx = await seedBriefCompleteRound();
    await seedBrief(ctx, frozen(buildBrief(ctx, { briefersNotes: "notes" })));
    vi.mocked(enqueueBriefPdf).mockRejectedValueOnce(new Error("queue unavailable"));

    const res = await lock(ctx);

    expect(res.status).toBe(200);
    const round = (await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`))!;
    expect(round.status).toBe("Locked");
    expect(round.brief?.pdfStatus).toBe("failed");
    expect(round.brief?.pdfError).toBe("enqueue_failed");
    expect(enqueueBriefPdf).toHaveBeenCalledTimes(1);
    expect(pdfMock.generateBriefPdf).not.toHaveBeenCalled();
    // The brief JSON (frozen material) was still written before the PDF step.
    const after = (await readPrivateJson<RoundBrief>(`round-briefs/${ctx.roundId}.json`))!;
    expect(computeBriefHash(after)).toBe(after.hash);
  });
});
