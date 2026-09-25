// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * Characterisation of `lockRound` (BriefComplete → Locked) before it joins the
 * round write table (issue #275, todo 1 — RED-FIRST).
 *
 * Every case here pins TODAY's exact behaviour of the bespoke handler, so the
 * refactor commit can prove it changed only the four accepted deviations
 * L1-L4. The case ids mark each expectation: `G` passes against the
 * unrefactored handler (a characterisation), `R` is the expected-red set that
 * todo 2 turns green:
 *
 *   - a6 (L3): an unsafe route id returns 400 INVALID_BLOB_PATH, not 500.
 *   - b1 ×5 (L1): the status-gate 409 carries `detail: "Expected status
 *     BriefComplete, got <status>"` (today the detail is discarded).
 *   - b2 (L2): the in-lease race re-check carries the same detail wording.
 *   - h1 (L4): a synchronous throw in post-commit work is contained (200, the
 *     lock stands, the republish still happens).
 *
 * The mocks are pass-through wrappers (`...actual`) around the real modules so
 * every case exercises the REAL storage/lease/ledger code against Azurite.
 */
import { randomUUID } from "node:crypto";
import type { HttpResponseInit } from "@azure/functions";
import { BlockBlobClient } from "@azure/storage-blob";
import type { Round, RoundBrief, RoundStatus, Season, Signature, User } from "@bccweb/types";
import { ROUND_STATUSES } from "@bccweb/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  invoke,
  makeAuthRequest,
  makeRequest,
} from "../../__tests__/helpers/api.js";
import { getPrivateContainer } from "../../__tests__/helpers/azurite.js";
import {
  makeUser,
  readPrivateJson,
  readPublicJson,
  writePrivateJson,
  writePublicJson,
} from "../../__tests__/helpers/seed.js";
import { computeBriefHash } from "../../lib/signTofly/briefVersion.js";
import { writeSignature } from "../../lib/signTofly/ledger.js";

// ─── Control state (vi.hoisted so the mocks below can close over it) ─────────

const control = vi.hoisted(() => ({
  /** Set to fail the brief-JSON write (round-briefs/*) with a plain Error. */
  failBriefWrite: false,
  /** Set to fail the round-JSON write (rounds/*), after calling the hook. */
  failRoundWrite: false,
  /** Runs inside the round-write failure branch, just before the throw. */
  onRoundWriteFailure: undefined as undefined | (() => void),
  /** Counts schema reads of round-briefs/* while a hook is armed. */
  briefReads: 0,
  /**
   * Fires on the Nth schema read of round-briefs/* (`at`), then disarms. The
   * hook may throw to simulate a brief read failure at that exact point.
   */
  briefReadHook: undefined as
    | undefined
    | { at: number; run: () => Promise<void> | void },
}));

const meter = vi.hoisted(() => ({
  /** `rounds/{id}.json` for the round under test, or null when disarmed. */
  roundPath: null as null | string,
  reads: 0,
  callers: 0,
}));

const telemetryMock = vi.hoisted(() => {
  const trackTrace = vi.fn();
  const trackEvent = vi.fn();
  const target: Record<string | symbol, unknown> = { trackTrace, trackEvent };
  const client = new Proxy(target, {
    get(proxyTarget, prop) {
      if (prop in proxyTarget) return proxyTarget[prop];
      const stub = vi.fn();
      proxyTarget[prop] = stub;
      return stub;
    },
  });
  return { trackTrace, trackEvent, client };
});

/** Real `listSignaturesForRound`, kept so f1 can call through the wrapper. */
const realListSignaturesForRound = vi.hoisted(() => ({
  fn: undefined as unknown as (
    roundId: string,
  ) => Promise<Signature[]>,
}));

// ─── Module mocks (declared before the code under test is imported) ──────────

// Wraps the REAL mutationRateLimit — copied from roundWriteContract.test.ts.
vi.mock("../../lib/rateLimit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/rateLimit.js")>();
  return { ...actual, mutationRateLimit: vi.fn(actual.mutationRateLimit) };
});

// readJson: meters round reads; fires the brief-read hook on the Nth brief
// read. writePrivateJson: fails the brief/round write when armed. Both delegate
// to the real function otherwise.
vi.mock("../../lib/blobJson.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/blobJson.js")>();
  return {
    ...actual,
    readJson: async <T>(
      ...args: Parameters<typeof actual.readJson<T>>
    ): Promise<T> => {
      if (meter.roundPath !== null && args[2] === meter.roundPath) {
        meter.reads += 1;
      }
      if (
        control.briefReadHook !== undefined &&
        typeof args[2] === "string" &&
        args[2].startsWith("round-briefs/")
      ) {
        control.briefReads += 1;
        if (control.briefReads === control.briefReadHook.at) {
          const hook = control.briefReadHook;
          control.briefReadHook = undefined;
          await hook.run();
        }
      }
      return actual.readJson(...args);
    },
    writePrivateJson: vi.fn(
      (
        path: string,
        schema: unknown,
        data: unknown,
        leaseId?: string,
        opts?: unknown,
      ) => {
        if (path.startsWith("round-briefs/") && control.failBriefWrite) {
          return Promise.reject(new Error("simulated brief JSON write failure"));
        }
        if (path.startsWith("rounds/") && control.failRoundWrite) {
          control.onRoundWriteFailure?.();
          return Promise.reject(new Error("simulated round JSON write failure"));
        }
        return (
          actual.writePrivateJson as unknown as (...args: unknown[]) => Promise<void>
        )(path, schema, data, leaseId, opts);
      },
    ),
  };
});

// Meters caller resolutions while armed. Copied from
// roundTransitionEfficiency.test.ts:71-83.
vi.mock("../../lib/auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/auth.js")>();
  return {
    ...actual,
    getCallerIdentity: (
      ...args: Parameters<typeof actual.getCallerIdentity>
    ): ReturnType<typeof actual.getCallerIdentity> => {
      if (meter.roundPath !== null) meter.callers += 1;
      return actual.getCallerIdentity(...args);
    },
  };
});

vi.mock("../../lib/recompute.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/recompute.js")>();
  return { ...actual, updateRoundsIndex: vi.fn(actual.updateRoundsIndex) };
});

vi.mock("../../lib/queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queue.js")>()),
  enqueueBriefPdf: vi.fn(),
  enqueuePureTrackGroupJob: vi.fn(),
}));

vi.mock("../../lib/briefPdf.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/briefPdf.js")>();
  return { ...actual, setBriefPdfStatus: vi.fn(actual.setBriefPdfStatus) };
});

vi.mock("../../lib/telemetry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/telemetry.js")>();
  return { ...actual, getTelemetryClient: () => telemetryMock.client };
});

vi.mock("../../lib/blob.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/blob.js")>();
  return {
    ...actual,
    withRoundAndBriefLease: vi.fn(actual.withRoundAndBriefLease),
  };
});

vi.mock("../../lib/signTofly/ledger.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../lib/signTofly/ledger.js")
  >();
  realListSignaturesForRound.fn = actual.listSignaturesForRound;
  return {
    ...actual,
    listSignaturesForRound: vi.fn(actual.listSignaturesForRound),
  };
});

import { mutationRateLimit, resetAllBuckets } from "../../lib/rateLimit.js";
import { updateRoundsIndex } from "../../lib/recompute.js";
import { enqueueBriefPdf, enqueuePureTrackGroupJob } from "../../lib/queue.js";
import { setBriefPdfStatus } from "../../lib/briefPdf.js";
import { withRoundAndBriefLease } from "../../lib/blob.js";
import { listSignaturesForRound } from "../../lib/signTofly/ledger.js";
import "../roundsMutate.js";

// ─── Exact response bodies (toEqual; requestId is undefined under test ctx) ──

const UNAUTHORIZED = { error: "Unauthorized", code: "UNAUTHORIZED" };
const FORBIDDEN = { error: "Forbidden", code: "FORBIDDEN" };
const SCOPE_FORBIDDEN = {
  error: "Forbidden",
  code: "FORBIDDEN",
  detail: "You can only manage rounds organised by your club",
};
const NOT_FOUND = {
  error: "Not Found",
  code: "NOT_FOUND",
  detail: "Round not found",
};
const MISSING_ID = {
  error: "Bad Request",
  code: "MISSING_ROUND_ID",
  detail: "Missing round id",
};
const INVALID_BLOB_PATH = {
  error: "Bad Request",
  code: "INVALID_BLOB_PATH",
  detail: "Invalid blob path",
};
const INTERNAL_500 = { error: "Internal Server Error", code: "INTERNAL" };
const BRIEF_REQUIRED = {
  error: "Conflict",
  code: "BRIEF_REQUIRED",
  detail: "A frozen brief must exist before locking — reopen and re-complete the round",
};
const HASH_MISMATCH = {
  error: "Conflict",
  code: "BRIEF_HASH_MISMATCH",
  detail:
    "Brief material no longer matches its frozen sign-to-fly hash — reopen and re-complete the round before locking",
};
const LEDGER_UNAVAILABLE = {
  error: "Internal Server Error",
  code: "SIGNATURE_LEDGER_UNAVAILABLE",
  detail:
    "Could not read the sign-to-fly ledger while locking — the round remains BriefComplete; retry once the ledger is readable",
};
const PERSIST_FAILED = {
  error: "Internal Server Error",
  code: "BRIEF_PERSIST_FAILED",
  detail:
    "Failed to persist the brief while locking — the round remains BriefComplete; reopen and re-complete before retrying the lock",
};
const conflict = (status: RoundStatus) => ({
  error: "Conflict",
  code: "CONFLICT",
  detail: `Expected status BriefComplete, got ${status}`,
});

// ─── Fixture (local copy of roundsMutate.lock.test.ts:71-220) ────────────────

interface Ctx {
  readonly roundId: string;
  readonly teamId: string;
  readonly pilotId: string;
  readonly adminUserId: string;
  readonly adminEmail: string;
  readonly clubId: string;
  readonly year: number;
}

function makeBrief(ctx: Ctx, overrides: Partial<RoundBrief> = {}): RoundBrief {
  return {
    roundId: ctx.roundId,
    generatedAt: "2026-06-01T08:00:00.000Z",
    date: `${ctx.year}-06-09`,
    siteName: "Milk Hill",
    parkingW3W: "filled.count.soap",
    briefingW3W: "brief.count.soap",
    takeOffW3W: "takeoff.count.soap",
    windSpeedDirection: "NW 15kt",
    pureTrackGroupName: "Stale round group",
    pureTrackGroupSlug: "stale-round-group",
    version: 1,
    teams: [
      {
        teamName: "Alpha",
        clubName: "Test Club",
        pureTrackGroupId: 101,
        pureTrackGroupSlug: "stale-team-group",
        pilots: [],
      },
    ],
    ...overrides,
  };
}

function frozenBrief(ctx: Ctx, overrides: Partial<RoundBrief> = {}): RoundBrief {
  const brief = makeBrief(ctx, overrides);
  return { ...brief, hash: computeBriefHash(brief) };
}

async function seedCurrentSignature(ctx: Ctx, placeInTeam = 1): Promise<void> {
  const signature: Signature = {
    id: randomUUID(),
    roundId: ctx.roundId,
    teamId: ctx.teamId,
    place: placeInTeam,
    pilotId: ctx.pilotId,
    userId: ctx.adminUserId,
    signedAt: new Date().toISOString(),
    briefVersion: 1,
    briefHash: computeBriefHash(frozenBrief(ctx)),
    wordingVersion: 1,
    wordingHash: "wording-hash",
    ip: "203.0.113.1",
    userAgent: "vitest",
    source: "pilot-self",
  };
  await writeSignature(signature);
}

async function seedLockable(
  opts: {
    status?: RoundStatus;
    brief?: "frozen" | "tampered" | "none";
    signed?: boolean;
  } = {},
): Promise<Ctx> {
  const status = opts.status ?? "BriefComplete";
  const year = 3000 + Math.floor(Math.random() * 6_000);
  const clubId = randomUUID();
  const pilotId = randomUUID();
  const teamId = randomUUID();
  const roundId = randomUUID();
  const { user: admin } = await makeUser({ roles: ["Admin"], clubId });

  const round: Round = {
    id: roundId,
    date: `${year}-06-09`,
    status,
    isLocked: status === "Locked",
    maxTeams: 8,
    minimumScore: 0,
    pureTrackGroupId: 100,
    pureTrackGroupName: "Stale round group",
    pureTrackGroupSlug: "stale-round-group",
    site: {
      id: randomUUID(),
      name: "Milk Hill",
      parkingW3W: "filled.count.soap",
      briefingW3W: "brief.count.soap",
      takeOffW3W: "takeoff.count.soap",
    },
    organisingClub: { id: clubId, name: "Test Club" },
    season: { year },
    teams: [
      {
        id: teamId,
        teamName: "Alpha",
        club: { id: clubId, name: "Test Club" },
        score: 0,
        pureTrackGroupId: 101,
        pureTrackGroupSlug: "stale-team-group",
        pilots: [
          {
            placeInTeam: 1,
            isScoring: true,
            status: "Filled",
            accountedFor: false,
            signToFly: false,
            noScore: false,
            pilotPoints: 0,
            pilotId,
            snapshot: { wingClass: "EN B", pilotRating: "Pilot" },
            flight: null,
          },
        ],
      },
    ],
  };

  await writePrivateJson(`rounds/${roundId}.json`, round);
  await writePrivateJson(`pilots/${pilotId}.json`, {
    id: pilotId,
    person: { firstName: "Lock", lastName: "Pilot", fullName: "Lock Pilot" },
    currentClub: { id: clubId, name: "Test Club" },
    wingClass: "EN B",
    pilotRating: "Pilot",
    bhpaNumber: 12345,
  });
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
      siteId: round.site.id,
      siteName: round.site.name,
      status: round.status,
      seasonYear: year,
    },
  ]);

  const ctx: Ctx = {
    roundId,
    teamId,
    pilotId,
    adminUserId: admin.id,
    adminEmail: admin.email,
    clubId,
    year,
  };

  const briefChoice = opts.brief ?? "frozen";
  if (briefChoice === "frozen") {
    await writePrivateJson(`round-briefs/${roundId}.json`, frozenBrief(ctx));
  } else if (briefChoice === "tampered") {
    await writePrivateJson(`round-briefs/${roundId}.json`, {
      ...makeBrief(ctx),
      hash: "TAMPERED-HASH-DOES-NOT-MATCH-MATERIAL",
    });
  }
  // "none" writes no brief blob.

  if (opts.signed !== false) {
    await seedCurrentSignature(ctx);
  }
  return ctx;
}

// ─── Local helpers ────────────────────────────────────────────────────────────

function bytes(path: string): Promise<Buffer> {
  return getPrivateContainer().getBlobClient(path).downloadToBuffer();
}

async function leaseState(path: string): Promise<string | undefined> {
  return (await getPrivateContainer().getBlobClient(path).getProperties())
    .leaseState;
}

/** Clear every mock whose calls a case asserts on. Call AFTER fixture setup. */
function clearAssertedMocks(): void {
  vi.mocked(mutationRateLimit).mockClear();
  vi.mocked(updateRoundsIndex).mockClear();
  vi.mocked(enqueueBriefPdf).mockClear();
  vi.mocked(enqueuePureTrackGroupJob).mockClear();
  vi.mocked(setBriefPdfStatus).mockClear();
  vi.mocked(listSignaturesForRound).mockClear();
  vi.mocked(withRoundAndBriefLease).mockClear();
  telemetryMock.trackTrace.mockClear();
  telemetryMock.trackEvent.mockClear();
}

function lock(
  user: Pick<User, "id" | "email">,
  id: string,
  query?: Record<string, string>,
): Promise<HttpResponseInit> {
  clearAssertedMocks();
  return invoke(
    "lockRound",
    makeAuthRequest(user.id, user.email, {
      method: "POST",
      params: { id },
      query,
    }),
  );
}

interface Measured {
  res: HttpResponseInit;
  reads: number;
  callers: number;
}

/** Arms the read/caller meter for exactly one lock invoke. */
async function measure(
  user: Pick<User, "id" | "email">,
  id: string,
): Promise<Measured> {
  meter.reads = 0;
  meter.callers = 0;
  meter.roundPath = `rounds/${id}.json`;
  clearAssertedMocks();
  try {
    const res = await invoke(
      "lockRound",
      makeAuthRequest(user.id, user.email, { method: "POST", params: { id } }),
    );
    return { res, reads: meter.reads, callers: meter.callers };
  } finally {
    meter.roundPath = null;
  }
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("lockRound contract characterisation (issue 275, red-first)", () => {
  beforeEach(() => {
    resetAllBuckets();
    vi.clearAllMocks();
    control.failBriefWrite = false;
    control.failRoundWrite = false;
    control.onRoundWriteFailure = undefined;
    control.briefReads = 0;
    control.briefReadHook = undefined;
    meter.roundPath = null;
    meter.reads = 0;
    meter.callers = 0;
    vi.mocked(enqueueBriefPdf).mockResolvedValue(undefined);
    vi.mocked(enqueuePureTrackGroupJob).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    control.failBriefWrite = false;
    control.failRoundWrite = false;
    control.onRoundWriteFailure = undefined;
    control.briefReads = 0;
    control.briefReadHook = undefined;
    meter.roundPath = null;
  });

  // ── (a) Response contract ────────────────────────────────────────────────

  it("a1 unauthenticated -> 401 UNAUTHORIZED, round bytes unchanged", async () => {
    const ctx = await seedLockable();
    const roundBefore = await bytes(`rounds/${ctx.roundId}.json`);

    clearAssertedMocks();
    const res = await invoke(
      "lockRound",
      makeRequest({ method: "POST", params: { id: ctx.roundId } }),
    );

    expect(res.status).toBe(401);
    expect(res.jsonBody).toEqual(UNAUTHORIZED);
    expect(await bytes(`rounds/${ctx.roundId}.json`)).toEqual(roundBefore);
  });

  it("a2 Pilot caller -> 403 FORBIDDEN, round bytes unchanged", async () => {
    const ctx = await seedLockable();
    const roundBefore = await bytes(`rounds/${ctx.roundId}.json`);
    const { user: pilot } = await makeUser({ roles: ["Pilot"] });

    const res = await lock(pilot, ctx.roundId);

    expect(res.status).toBe(403);
    expect(res.jsonBody).toEqual(FORBIDDEN);
    expect(await bytes(`rounds/${ctx.roundId}.json`)).toEqual(roundBefore);
  });

  it("a3 RoundsCoord of another club -> 403 SCOPE_FORBIDDEN, round and brief bytes unchanged", async () => {
    const ctx = await seedLockable();
    const roundBefore = await bytes(`rounds/${ctx.roundId}.json`);
    const briefBefore = await bytes(`round-briefs/${ctx.roundId}.json`);
    const { user: other } = await makeUser({
      roles: ["RoundsCoord"],
      clubId: randomUUID(),
    });

    const res = await lock(other, ctx.roundId);

    expect(res.status).toBe(403);
    expect(res.jsonBody).toEqual(SCOPE_FORBIDDEN);
    expect(await bytes(`rounds/${ctx.roundId}.json`)).toEqual(roundBefore);
    expect(await bytes(`round-briefs/${ctx.roundId}.json`)).toEqual(briefBefore);
  });

  it("a4 Admin on a missing round -> 404 NOT_FOUND", async () => {
    const ctx = await seedLockable();
    void ctx;
    const { user: admin } = await makeUser({ roles: ["Admin"] });

    const res = await lock(admin, randomUUID());

    expect(res.status).toBe(404);
    expect(res.jsonBody).toEqual(NOT_FOUND);
  });

  it("a5 Admin with no id param -> 400 MISSING_ROUND_ID", async () => {
    const ctx = await seedLockable();
    const admin = { id: ctx.adminUserId, email: ctx.adminEmail };

    clearAssertedMocks();
    const res = await invoke(
      "lockRound",
      makeAuthRequest(admin.id, admin.email, { method: "POST" }),
    );

    expect(res.status).toBe(400);
    expect(res.jsonBody).toEqual(MISSING_ID);
  });

  it("a6 unsafe id -> 400 INVALID_BLOB_PATH (L3: 500 on unrefactored main)", async () => {
    const ctx = await seedLockable();
    const admin = { id: ctx.adminUserId, email: ctx.adminEmail };

    const res = await lock(admin, "a@b");

    expect(res.status).toBe(400);
    expect(res.jsonBody).toEqual(INVALID_BLOB_PATH);
  });

  // ── (b) Status gate ──────────────────────────────────────────────────────

  const NON_BRIEF_COMPLETE = ROUND_STATUSES.filter((s) => s !== "BriefComplete");
  it("b1 setup: exactly five non-BriefComplete statuses", () => {
    expect(NON_BRIEF_COMPLETE).toHaveLength(5);
  });

  it.each(NON_BRIEF_COMPLETE)(
    "b1 status gate: a %s round -> 409 with the expectedStatusDetail (L1)",
    async (status) => {
      const ctx = await seedLockable({ status });
      const roundBefore = await bytes(`rounds/${ctx.roundId}.json`);
      const admin = { id: ctx.adminUserId, email: ctx.adminEmail };

      const res = await lock(admin, ctx.roundId);

      expect(res.jsonBody).toEqual(conflict(status));
      expect(res.status).toBe(409);
      expect(await bytes(`rounds/${ctx.roundId}.json`)).toEqual(roundBefore);
      expect(enqueueBriefPdf).not.toHaveBeenCalled();
      expect(enqueuePureTrackGroupJob).not.toHaveBeenCalled();
      expect(updateRoundsIndex).not.toHaveBeenCalled();
      const limiter = vi.mocked(mutationRateLimit);
      expect(limiter).toHaveBeenCalledTimes(1);
      expect(limiter.mock.calls[0]?.[2]).toBe("lockRound");
      expect(limiter.mock.calls[0]?.[3]).toBe("heavy");
    },
  );

  it("b2 race: the status flips between the pre-lease brief check and the leased read -> 409 with detail (L2)", async () => {
    const ctx = await seedLockable();
    const roundPath = `rounds/${ctx.roundId}.json`;
    const briefBefore = await bytes(`round-briefs/${ctx.roundId}.json`);
    const admin = { id: ctx.adminUserId, email: ctx.adminEmail };

    control.briefReadHook = {
      at: 1,
      run: async () => {
        const r = await readPrivateJson<Round>(roundPath);
        await writePrivateJson(roundPath, { ...r!, status: "Confirmed" });
      },
    };

    const res = await lock(admin, ctx.roundId);

    expect(res.status).toBe(409);
    expect(res.jsonBody).toEqual(conflict("Confirmed"));
    expect((await readPrivateJson<Round>(roundPath))?.status).toBe("Confirmed");
    expect(await bytes(`round-briefs/${ctx.roundId}.json`)).toEqual(briefBefore);
    expect(updateRoundsIndex).not.toHaveBeenCalled();
  });

  // ── (c) Pre-lease gates ──────────────────────────────────────────────────

  it("c1 no brief -> 409 BRIEF_REQUIRED; the lease is never taken", async () => {
    const ctx = await seedLockable({ brief: "none" });
    const roundBefore = await bytes(`rounds/${ctx.roundId}.json`);
    const admin = { id: ctx.adminUserId, email: ctx.adminEmail };

    const res = await lock(admin, ctx.roundId);

    expect(res.status).toBe(409);
    expect(res.jsonBody).toEqual(BRIEF_REQUIRED);
    expect(await bytes(`rounds/${ctx.roundId}.json`)).toEqual(roundBefore);
    expect(withRoundAndBriefLease).not.toHaveBeenCalled();
  });

  it("c2 a Confirmed round with no brief -> 409 CONFLICT (status gate precedes BRIEF_REQUIRED)", async () => {
    const ctx = await seedLockable({ status: "Confirmed", brief: "none" });
    const admin = { id: ctx.adminUserId, email: ctx.adminEmail };

    const res = await lock(admin, ctx.roundId);

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code?: string })?.code).toBe("CONFLICT");
  });

  it("c3 the pre-lease brief read fails -> 500 INTERNAL, no lease taken", async () => {
    const ctx = await seedLockable();
    const roundBefore = await bytes(`rounds/${ctx.roundId}.json`);
    const admin = { id: ctx.adminUserId, email: ctx.adminEmail };

    control.briefReadHook = {
      at: 1,
      run: () => {
        throw Object.assign(new Error("injected brief read failure"), {
          statusCode: 503,
        });
      },
    };

    const res = await lock(admin, ctx.roundId);

    expect(res.status).toBe(500);
    expect(res.jsonBody).toEqual(INTERNAL_500);
    expect(await bytes(`rounds/${ctx.roundId}.json`)).toEqual(roundBefore);
    expect(withRoundAndBriefLease).not.toHaveBeenCalled();
  });

  // ── (d) In-lease gates ───────────────────────────────────────────────────

  it("d1 tampered brief -> 409 BRIEF_HASH_MISMATCH with one brief.lockHashMismatch trace", async () => {
    const ctx = await seedLockable({ brief: "tampered" });
    const roundBefore = await bytes(`rounds/${ctx.roundId}.json`);
    const briefBefore = await bytes(`round-briefs/${ctx.roundId}.json`);
    const admin = { id: ctx.adminUserId, email: ctx.adminEmail };

    const res = await lock(admin, ctx.roundId);

    expect(res.status).toBe(409);
    expect(res.jsonBody).toEqual(HASH_MISMATCH);
    expect(telemetryMock.trackTrace).toHaveBeenCalledTimes(1);
    expect(telemetryMock.trackTrace).toHaveBeenCalledWith({
      message: "brief.lockHashMismatch",
      properties: { roundId: ctx.roundId },
    });
    expect(await bytes(`rounds/${ctx.roundId}.json`)).toEqual(roundBefore);
    expect(await bytes(`round-briefs/${ctx.roundId}.json`)).toEqual(briefBefore);
  });

  it("d2 tampered brief and unsigned slot -> 409 BRIEF_HASH_MISMATCH (hash gate precedes the ledger read)", async () => {
    const ctx = await seedLockable({ brief: "tampered", signed: false });
    const admin = { id: ctx.adminUserId, email: ctx.adminEmail };

    const res = await lock(admin, ctx.roundId);

    expect(res.status).toBe(409);
    expect(res.jsonBody).toEqual(HASH_MISMATCH);
    expect(listSignaturesForRound).not.toHaveBeenCalled();
  });

  it("d3 the ledger read fails -> 500 SIGNATURE_LEDGER_UNAVAILABLE", async () => {
    const ctx = await seedLockable();
    const roundBefore = await bytes(`rounds/${ctx.roundId}.json`);
    const briefBefore = await bytes(`round-briefs/${ctx.roundId}.json`);
    const admin = { id: ctx.adminUserId, email: ctx.adminEmail };

    vi.mocked(listSignaturesForRound).mockRejectedValueOnce(
      new Error("ledger down"),
    );

    const res = await lock(admin, ctx.roundId);

    expect(res.status).toBe(500);
    expect(res.jsonBody).toEqual(LEDGER_UNAVAILABLE);
    expect(await bytes(`rounds/${ctx.roundId}.json`)).toEqual(roundBefore);
    expect(await bytes(`round-briefs/${ctx.roundId}.json`)).toEqual(briefBefore);
  });

  it("d4 an unsigned Filled slot -> 409 SIGNATURES_INCOMPLETE naming the slot", async () => {
    const ctx = await seedLockable({ signed: false });
    const roundBefore = await bytes(`rounds/${ctx.roundId}.json`);
    const admin = { id: ctx.adminUserId, email: ctx.adminEmail };

    const res = await lock(admin, ctx.roundId);

    expect(res.status).toBe(409);
    expect(res.jsonBody).toEqual({
      error: "Conflict",
      code: "SIGNATURES_INCOMPLETE",
      detail: `Unsigned slots: Alpha #1 (${ctx.pilotId})`,
    });
    expect(await bytes(`rounds/${ctx.roundId}.json`)).toEqual(roundBefore);
  });

  // ── (e) Commit and rollback ──────────────────────────────────────────────

  it("e1 BRIEF_PERSIST_FAILED: the brief write fails -> 500, nothing else happens", async () => {
    const ctx = await seedLockable();
    const roundBefore = await bytes(`rounds/${ctx.roundId}.json`);
    const briefBefore = await bytes(`round-briefs/${ctx.roundId}.json`);
    const admin = { id: ctx.adminUserId, email: ctx.adminEmail };

    control.failBriefWrite = true;
    const res = await lock(admin, ctx.roundId);

    expect(res.status).toBe(500);
    expect(res.jsonBody).toEqual(PERSIST_FAILED);
    expect(await bytes(`rounds/${ctx.roundId}.json`)).toEqual(roundBefore);
    expect(await bytes(`round-briefs/${ctx.roundId}.json`)).toEqual(briefBefore);
    const reconcileCalls = telemetryMock.trackEvent.mock.calls.filter(
      ([arg]) =>
        (arg as { name?: string }).name ===
        "puretrack.crossBlobReconcileRequired",
    );
    expect(reconcileCalls).toHaveLength(0);
    expect(enqueueBriefPdf).not.toHaveBeenCalled();
    expect(enqueuePureTrackGroupJob).not.toHaveBeenCalled();
    expect(updateRoundsIndex).not.toHaveBeenCalled();
  });

  it("e2 BRIEF_PERSIST_FAILED: the round write fails -> 500 and the rollback restores the brief byte-exact", async () => {
    const ctx = await seedLockable();
    const roundBefore = await bytes(`rounds/${ctx.roundId}.json`);
    const admin = { id: ctx.adminUserId, email: ctx.adminEmail };

    const briefBefore = await bytes(`round-briefs/${ctx.roundId}.json`);
    control.failRoundWrite = true;
    const res = await lock(admin, ctx.roundId);

    expect(res.status).toBe(500);
    expect(res.jsonBody).toEqual(PERSIST_FAILED);
    expect(
      (await bytes(`round-briefs/${ctx.roundId}.json`)).equals(briefBefore),
    ).toBe(true);
    expect(await bytes(`rounds/${ctx.roundId}.json`)).toEqual(roundBefore);
    const reconcileCalls = telemetryMock.trackEvent.mock.calls.filter(
      ([arg]) =>
        (arg as { name?: string }).name ===
        "puretrack.crossBlobReconcileRequired",
    );
    expect(reconcileCalls).toHaveLength(0);
  });

  it("e3 BRIEF_PERSIST_FAILED: the rollback itself fails -> one puretrack.crossBlobReconcileRequired event", async () => {
    const ctx = await seedLockable();
    const admin = { id: ctx.adminUserId, email: ctx.adminEmail };

    control.failRoundWrite = true;
    control.onRoundWriteFailure = () => {
      vi.spyOn(BlockBlobClient.prototype, "upload").mockRejectedValueOnce(
        new Error("injected rollback failure"),
      );
    };

    const res = await lock(admin, ctx.roundId);

    expect(res.status).toBe(500);
    expect(res.jsonBody).toEqual(PERSIST_FAILED);
    expect(telemetryMock.trackEvent).toHaveBeenCalledTimes(1);
    expect(telemetryMock.trackEvent).toHaveBeenCalledWith({
      name: "puretrack.crossBlobReconcileRequired",
      properties: {
        roundId: ctx.roundId,
        operation: "lock",
        roundWriteError: "Error",
        rollbackError: "Error",
      },
    });
    expect(
      (await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`))?.status,
    ).toBe("BriefComplete");
  });

  it("e4 BRIEF_PERSIST_FAILED: the brief vanishes between the pre-lease check and the leased read -> 500, not 404", async () => {
    const ctx = await seedLockable();
    const roundBefore = await bytes(`rounds/${ctx.roundId}.json`);
    const admin = { id: ctx.adminUserId, email: ctx.adminEmail };

    control.briefReadHook = {
      at: 2,
      run: () => {
        throw Object.assign(new Error("brief vanished"), { statusCode: 404 });
      },
    };

    const res = await lock(admin, ctx.roundId);

    expect(res.status).toBe(500);
    expect(res.jsonBody).toEqual(PERSIST_FAILED);
    expect(await bytes(`rounds/${ctx.roundId}.json`)).toEqual(roundBefore);
  });

  // ── (f) Leases ───────────────────────────────────────────────────────────

  it("f1 both leases are held while the signature ledger is read", async () => {
    const ctx = await seedLockable();
    const roundPath = `rounds/${ctx.roundId}.json`;
    const briefPath = `round-briefs/${ctx.roundId}.json`;
    const admin = { id: ctx.adminUserId, email: ctx.adminEmail };
    const states: Array<string | undefined> = [];

    vi.mocked(listSignaturesForRound).mockImplementationOnce(
      async (roundId: string) => {
        states.push(await leaseState(roundPath), await leaseState(briefPath));
        return realListSignaturesForRound.fn(roundId);
      },
    );

    const res = await lock(admin, ctx.roundId);

    expect(res.status).toBe(200);
    expect(states).toEqual(["leased", "leased"]);
    expect(withRoundAndBriefLease).toHaveBeenCalledTimes(1);
    expect(vi.mocked(withRoundAndBriefLease).mock.calls[0]?.[0]).toBe(
      ctx.roundId,
    );
  });

  // ── (g) Success path ─────────────────────────────────────────────────────

  it("g1 admin lock: 200, persisted Locked round, snapshot, echo clearing, enqueues then republish, budget 2 reads / 1 caller", async () => {
    const ctx = await seedLockable();
    const admin = { id: ctx.adminUserId, email: ctx.adminEmail };

    const { res, reads, callers } = await measure(admin, ctx.roundId);

    expect(res.status).toBe(200);
    const persisted = (await readPrivateJson<Round>(
      `rounds/${ctx.roundId}.json`,
    ))!;
    expect(res.jsonBody).toEqual(persisted);
    expect(persisted.status).toBe("Locked");
    expect(persisted.isLocked).toBe(true);
    expect(persisted.pureTrack).toMatchObject({
      status: "pending",
      attemptId: expect.any(String),
    });
    expect(persisted.brief).toMatchObject({
      version: 1,
      pdfStatus: "pending",
      pdfAttemptId: expect.any(String),
      jsonPath: `round-briefs/${ctx.roundId}.json`,
      pdfPath: `round-briefs/${ctx.roundId}.pdf`,
    });

    // Slot 1: fresh snapshot, accountedFor reset, signToFly materialised.
    const slot = persisted.teams[0]?.pilots[0];
    expect(slot?.snapshot).toEqual({ wingClass: "EN B", pilotRating: "Pilot" });
    expect(slot?.accountedFor).toBe(false);
    expect(slot?.signToFly).toBe(true);

    // PureTrack echoes cleared on the round, its team and the persisted brief.
    expect(persisted.pureTrackGroupId).toBeUndefined();
    expect(persisted.pureTrackGroupName).toBeUndefined();
    expect(persisted.pureTrackGroupSlug).toBeUndefined();
    expect(persisted.teams[0]?.pureTrackGroupId).toBeUndefined();
    expect(persisted.teams[0]?.pureTrackGroupSlug).toBeUndefined();
    const lockedBrief = (await readPrivateJson<RoundBrief>(
      `round-briefs/${ctx.roundId}.json`,
    ))!;
    expect(lockedBrief.pureTrackGroupName).toBeUndefined();
    expect(lockedBrief.pureTrackGroupSlug).toBeUndefined();
    expect(lockedBrief.teams[0]?.pureTrackGroupId).toBeUndefined();
    expect(lockedBrief.teams[0]?.pureTrackGroupSlug).toBeUndefined();
    expect(computeBriefHash(lockedBrief)).toBe(lockedBrief.hash);

    // rounds.json carries the new status.
    const index = await readPublicJson<Array<{ id: string; status: string }>>(
      "rounds.json",
    );
    expect(index?.find((entry) => entry.id === ctx.roundId)?.status).toBe(
      "Locked",
    );

    // Budget (vacuity guards first, then the targets).
    const limiter = vi.mocked(mutationRateLimit);
    expect(limiter).toHaveBeenCalledTimes(1);
    expect(limiter.mock.calls[0]?.[2]).toBe("lockRound");
    expect(limiter.mock.calls[0]?.[3]).toBe("heavy");
    expect(reads).toBeGreaterThanOrEqual(1);
    expect(callers).toBeGreaterThanOrEqual(1);
    expect.soft(callers).toBe(1);
    expect.soft(reads).toBe(2);

    // Calls: enqueues carry the persisted attempt ids; republish carries Locked.
    expect(updateRoundsIndex).toHaveBeenCalledTimes(1);
    expect(updateRoundsIndex).toHaveBeenCalledWith(
      expect.objectContaining({ id: ctx.roundId, status: "Locked" }),
    );
    expect(enqueueBriefPdf).toHaveBeenCalledTimes(1);
    expect(enqueueBriefPdf).toHaveBeenCalledWith({
      roundId: ctx.roundId,
      briefVersion: 1,
      pdfAttemptId: persisted.brief?.pdfAttemptId,
    });
    expect(enqueuePureTrackGroupJob).toHaveBeenCalledTimes(1);
    expect(enqueuePureTrackGroupJob).toHaveBeenCalledWith({
      roundId: ctx.roundId,
      attemptId: persisted.pureTrack?.attemptId,
    });

    // Order: the republish runs AFTER both post-commit enqueues.
    const republishOrder = vi.mocked(updateRoundsIndex).mock
      .invocationCallOrder[0];
    expect(republishOrder).toBeGreaterThan(
      vi.mocked(enqueueBriefPdf).mock.invocationCallOrder[0],
    );
    expect(republishOrder).toBeGreaterThan(
      vi.mocked(enqueuePureTrackGroupJob).mock.invocationCallOrder[0],
    );
  });

  it("g2 ?dryRun=true is ignored: lock has no preview and still locks", async () => {
    const ctx = await seedLockable();
    const admin = { id: ctx.adminUserId, email: ctx.adminEmail };

    const res = await lock(admin, ctx.roundId, { dryRun: "true" });

    expect(res.status).toBe(200);
    expect(
      (await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`))?.status,
    ).toBe("Locked");
  });

  // ── (h) Post-commit containment ──────────────────────────────────────────

  it("h1 L4: a synchronous throw in post-commit recovery is contained — 200, Locked, republished, logged", async () => {
    const ctx = await seedLockable();
    const admin = { id: ctx.adminUserId, email: ctx.adminEmail };

    vi.mocked(enqueueBriefPdf).mockRejectedValueOnce(
      new Error("queue unavailable"),
    );
    vi.mocked(setBriefPdfStatus).mockImplementationOnce(() => {
      throw new Error("sync recovery failure");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await lock(admin, ctx.roundId);

    expect(res.status).toBe(200);
    expect(
      (await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`))?.status,
    ).toBe("Locked");
    const index = await readPublicJson<Array<{ id: string; status: string }>>(
      "rounds.json",
    );
    expect(index?.find((entry) => entry.id === ctx.roundId)?.status).toBe(
      "Locked",
    );
    const logged = errorSpy.mock.calls.some(
      ([first]) =>
        typeof first === "string" &&
        first.includes("post-commit work failed after the write committed"),
    );
    expect(logged).toBe(true);
  });
});
