// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * Characterisation of `completeRound` (Locked → Complete) before it joins the
 * round write table (issue #276, todo 1 — RED-FIRST).
 *
 * Every case here pins TODAY's exact behaviour of the bespoke handler
 * (roundsMutate.ts:1099-1204), so the refactor commit can prove it changed only
 * the four accepted deviations C1-C4. The case ids mark each expectation:
 * `G` passes against the unrefactored handler (a characterisation), `R` is the
 * expected-red set that todo 2 turns green:
 *
 *   - a6 (C3): an unsafe route id returns 400 INVALID_BLOB_PATH, not 500.
 *   - b1 ×5 (C1): the status-gate 409 carries `detail: "Expected status Locked,
 *     got <status>"` (today the handler returns a bespoke non-HttpError body).
 *   - b2 (C2): the in-lease race re-check carries the same detail wording.
 *   - h2 (C4): a synchronous throw in post-response work is contained and
 *     logged via ctx.error (today it escapes as an unhandled rejection).
 *
 * The mocks are pass-through wrappers (`...actual`) around the real modules so
 * every case exercises the REAL storage/lease code against Azurite.
 */
import { randomUUID } from "node:crypto";
import type { HttpResponseInit } from "@azure/functions";
import type { Round, RoundStatus, User } from "@bccweb/types";
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
} from "../../__tests__/helpers/seed.js";

// ─── Control state (vi.hoisted so the mocks below can close over it) ─────────

const control = vi.hoisted(() => ({
  /** Set to fail the round-JSON write (rounds/*) with a plain Error. */
  failRoundWrite: false,
  /**
   * One-shot hook fired inside the withPrivateLeaseRenewing wrapper BEFORE the
   * real acquisition — i.e. after the handler's pre-read on both the old and
   * the new code. Cleared when fired.
   */
  beforeLease: undefined as undefined | ((path: string) => Promise<void>),
  /**
   * One-shot hook fired on the config.json read, then cleared. May throw to
   * simulate a transient config read failure.
   */
  onConfigRead: undefined as undefined | (() => Promise<void> | void),
  /** Counts schema reads of config.json. */
  configReads: 0,
}));

const meter = vi.hoisted(() => ({
  /** `rounds/{id}.json` for the round under test, or null when disarmed. */
  roundPath: null as null | string,
  reads: 0,
  callers: 0,
}));

// ─── Module mocks (declared before the code under test is imported) ──────────

// Wraps the REAL mutationRateLimit — copied from roundWriteContract.test.ts.
vi.mock("../../lib/rateLimit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/rateLimit.js")>();
  return { ...actual, mutationRateLimit: vi.fn(actual.mutationRateLimit) };
});

// readJson: meters round reads; fires the config hook (which may throw).
// writePrivateJson: fails the round write when armed. Both delegate otherwise.
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
      if (args[2] === "config.json") {
        control.configReads += 1;
        if (control.onConfigRead !== undefined) {
          const hook = control.onConfigRead;
          control.onConfigRead = undefined;
          await hook();
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
        if (path.startsWith("rounds/") && control.failRoundWrite) {
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
// lockRoundTransition.test.ts:154-165.
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

// recomputeSeason is stubbed so no real recompute runs in the background
// (completeRoundAccountedFor.test.ts:10-13); updateRoundsIndex stays real.
vi.mock("../../lib/recompute.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/recompute.js")>();
  return {
    ...actual,
    updateRoundsIndex: vi.fn(actual.updateRoundsIndex),
    recomputeSeason: vi.fn().mockResolvedValue(undefined),
  };
});

// Fires the one-shot beforeLease hook BEFORE the real lease acquisition
// (roundLifecycle.integration.test.ts:61-83) — after the pre-read on both the
// old and the new code, so a racing write lands between them.
vi.mock("../../lib/blob.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/blob.js")>();
  return {
    ...actual,
    withPrivateLeaseRenewing: vi.fn(
      async <T>(
        path: string,
        fn: (leaseId: string) => Promise<T>,
        opts?: Parameters<typeof actual.withPrivateLeaseRenewing>[2],
      ): Promise<T> => {
        const hook = control.beforeLease;
        if (hook) {
          control.beforeLease = undefined;
          await hook(path);
        }
        return actual.withPrivateLeaseRenewing(path, fn, opts);
      },
    ),
  };
});

import { mutationRateLimit, resetAllBuckets } from "../../lib/rateLimit.js";
import { updateRoundsIndex, recomputeSeason } from "../../lib/recompute.js";
import { withPrivateLeaseRenewing } from "../../lib/blob.js";
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
// Capital "S": the HttpError path, NOT the lowercase generic catch-all.
const INTERNAL_500 = { error: "Internal Server Error", code: "INTERNAL" };
const GENERIC_500 = { error: "Internal server error", code: "INTERNAL" };
const RATE_LIMITED = {
  error: "Too Many Requests",
  code: "RATE_LIMITED",
  detail: "Too many requests; try again later.",
};
const conflict = (status: RoundStatus) => ({
  error: "Conflict",
  code: "CONFLICT",
  detail: `Expected status Locked, got ${status}`,
});
const unaccounted = (pilotId: string) => ({
  error: "Conflict",
  code: "PILOTS_NOT_ACCOUNTED_FOR",
  detail: `Unaccounted-for slots: Alpha #1 (${pilotId})`,
});

// ─── Fixture (shaped like completeRoundAccountedFor.test.ts:34-63) ───────────

interface Ctx {
  readonly roundId: string;
  readonly pilotId: string;
  readonly clubId: string;
  readonly year: number;
  readonly admin: Pick<User, "id" | "email">;
}

async function seedCompletable(
  opts: { status?: RoundStatus; accounted?: boolean } = {},
): Promise<Ctx> {
  const status = opts.status ?? "Locked";
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
    site: { id: randomUUID(), name: "Milk Hill" },
    organisingClub: { id: clubId, name: "Test Club" },
    season: { year },
    teams: [
      {
        id: teamId,
        teamName: "Alpha",
        club: { id: clubId, name: "Test Club" },
        score: 0,
        captainPilotId: null,
        pilots: [
          {
            placeInTeam: 1,
            isScoring: true,
            status: "Filled",
            accountedFor: opts.accounted ?? true,
            signToFly: false,
            noScore: false,
            pilotPoints: 0,
            pilotId,
            snapshot: null,
            flight: null,
          },
        ],
      },
    ],
  };

  await writePrivateJson(`rounds/${roundId}.json`, round);

  // Round-trip guard (completeRoundAccountedFor.test.ts:69-78): catch a
  // schema heal silently dropping the team/slot before any behaviour
  // assertion runs.
  const stored = await readPrivateJson<Round>(`rounds/${roundId}.json`);
  expect(stored?.teams.length).toBe(1);
  expect(stored?.teams[0]?.pilots.length).toBe(1);

  return {
    roundId,
    pilotId,
    clubId,
    year,
    admin: { id: admin.id, email: admin.email },
  };
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
  vi.mocked(recomputeSeason).mockClear();
  vi.mocked(withPrivateLeaseRenewing).mockClear();
  control.configReads = 0;
}

function complete(
  user: Pick<User, "id" | "email">,
  id: string,
  query?: Record<string, string>,
): Promise<HttpResponseInit> {
  clearAssertedMocks();
  return invoke(
    "completeRound",
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

/** Arms the read/caller meter for exactly one complete invoke. */
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
      "completeRound",
      makeAuthRequest(user.id, user.email, { method: "POST", params: { id } }),
    );
    return { res, reads: meter.reads, callers: meter.callers };
  } finally {
    meter.roundPath = null;
  }
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("completeRound contract characterisation (issue 276, red-first)", () => {
  beforeEach(() => {
    resetAllBuckets();
    vi.clearAllMocks();
    control.failRoundWrite = false;
    control.beforeLease = undefined;
    control.onConfigRead = undefined;
    control.configReads = 0;
    meter.roundPath = null;
    meter.reads = 0;
    meter.callers = 0;
    vi.mocked(recomputeSeason).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    control.failRoundWrite = false;
    control.beforeLease = undefined;
    control.onConfigRead = undefined;
    control.configReads = 0;
    meter.roundPath = null;
  });

  // ── (a) Response contract ────────────────────────────────────────────────

  it("a1 unauthenticated -> 401 UNAUTHORIZED, round bytes unchanged", async () => {
    const ctx = await seedCompletable();
    const roundBefore = await bytes(`rounds/${ctx.roundId}.json`);

    clearAssertedMocks();
    const res = await invoke(
      "completeRound",
      makeRequest({ method: "POST", params: { id: ctx.roundId } }),
    );

    expect(res.status).toBe(401);
    expect(res.jsonBody).toEqual(UNAUTHORIZED);
    expect(await bytes(`rounds/${ctx.roundId}.json`)).toEqual(roundBefore);
    expect(updateRoundsIndex).not.toHaveBeenCalled();
    expect(recomputeSeason).not.toHaveBeenCalled();
  });

  it("a2 Pilot caller -> 403 FORBIDDEN, round bytes unchanged", async () => {
    const ctx = await seedCompletable();
    const roundBefore = await bytes(`rounds/${ctx.roundId}.json`);
    const { user: pilot } = await makeUser({ roles: ["Pilot"] });

    const res = await complete(pilot, ctx.roundId);

    expect(res.status).toBe(403);
    expect(res.jsonBody).toEqual(FORBIDDEN);
    expect(await bytes(`rounds/${ctx.roundId}.json`)).toEqual(roundBefore);
    expect(updateRoundsIndex).not.toHaveBeenCalled();
    expect(recomputeSeason).not.toHaveBeenCalled();
  });

  it("a3 RoundsCoord of another club -> 403 SCOPE_FORBIDDEN, scope precedes the limiter and the lease", async () => {
    const ctx = await seedCompletable();
    const roundBefore = await bytes(`rounds/${ctx.roundId}.json`);
    const { user: other } = await makeUser({
      roles: ["RoundsCoord"],
      clubId: randomUUID(),
    });

    const res = await complete(other, ctx.roundId);

    expect(res.status).toBe(403);
    expect(res.jsonBody).toEqual(SCOPE_FORBIDDEN);
    expect(await bytes(`rounds/${ctx.roundId}.json`)).toEqual(roundBefore);
    expect(updateRoundsIndex).not.toHaveBeenCalled();
    expect(recomputeSeason).not.toHaveBeenCalled();
    expect(mutationRateLimit).not.toHaveBeenCalled();
    expect(withPrivateLeaseRenewing).not.toHaveBeenCalled();
  });

  it("a4 Admin on a missing round -> 404 NOT_FOUND, no lease taken", async () => {
    const ctx = await seedCompletable();

    const res = await complete(ctx.admin, randomUUID());

    expect(res.status).toBe(404);
    expect(res.jsonBody).toEqual(NOT_FOUND);
    expect(withPrivateLeaseRenewing).not.toHaveBeenCalled();
  });

  it("a5 Admin with no id param -> 400 MISSING_ROUND_ID", async () => {
    const ctx = await seedCompletable();

    clearAssertedMocks();
    const res = await invoke(
      "completeRound",
      makeAuthRequest(ctx.admin.id, ctx.admin.email, { method: "POST" }),
    );

    expect(res.status).toBe(400);
    expect(res.jsonBody).toEqual(MISSING_ID);
  });

  it("a6 unsafe id -> 400 INVALID_BLOB_PATH (C3: 500 on unrefactored main)", async () => {
    const ctx = await seedCompletable();

    const res = await complete(ctx.admin, "a@b");

    expect(res.status).toBe(400);
    expect(res.jsonBody).toEqual(INVALID_BLOB_PATH);
  });

  it("a7 heavy bucket: five completes 409, the sixth 429 RATE_LIMITED with Retry-After", async () => {
    const ctx = await seedCompletable({ status: "Proposed" });
    const roundBefore = await bytes(`rounds/${ctx.roundId}.json`);

    for (let i = 0; i < 5; i += 1) {
      const res = await complete(ctx.admin, ctx.roundId);
      expect(res.status).toBe(409);
    }
    const res = await complete(ctx.admin, ctx.roundId);

    expect(res.status).toBe(429);
    expect(res.jsonBody).toEqual(RATE_LIMITED);
    expect(
      (res.headers as Record<string, string> | undefined)?.["Retry-After"],
    ).toMatch(/^\d+$/);
    expect(await bytes(`rounds/${ctx.roundId}.json`)).toEqual(roundBefore);
    expect(withPrivateLeaseRenewing).not.toHaveBeenCalled();
  });

  // ── (b) Status gate ──────────────────────────────────────────────────────

  const NON_LOCKED = ROUND_STATUSES.filter((s) => s !== "Locked");
  it("b1 setup: exactly five non-Locked statuses", () => {
    expect(NON_LOCKED).toHaveLength(5);
  });

  it.each(NON_LOCKED)(
    "b1 status gate: a %s round -> 409 with the expectedStatusDetail (C1)",
    async (status) => {
      const ctx = await seedCompletable({ status });
      const roundBefore = await bytes(`rounds/${ctx.roundId}.json`);

      const res = await complete(ctx.admin, ctx.roundId);

      expect(res.jsonBody).toEqual(conflict(status));
      expect(res.status).toBe(409);
      expect(await bytes(`rounds/${ctx.roundId}.json`)).toEqual(roundBefore);
      expect(updateRoundsIndex).not.toHaveBeenCalled();
      expect(recomputeSeason).not.toHaveBeenCalled();
      expect(withPrivateLeaseRenewing).not.toHaveBeenCalled();
      const limiter = vi.mocked(mutationRateLimit);
      expect(limiter).toHaveBeenCalledTimes(1);
      expect(limiter.mock.calls[0]?.[2]).toBe("completeRound");
      expect(limiter.mock.calls[0]?.[3]).toBe("heavy");
    },
  );

  it("b2 race: the status flips between the pre-read and the leased read -> 409 with detail (C2)", async () => {
    const ctx = await seedCompletable();
    const roundPath = `rounds/${ctx.roundId}.json`;

    control.beforeLease = async (p) => {
      const r = await readPrivateJson<Round>(p);
      await writePrivateJson(p, { ...r!, status: "Complete" });
    };

    const res = await complete(ctx.admin, ctx.roundId);

    expect(res.status).toBe(409);
    expect(res.jsonBody).toEqual(conflict("Complete"));
    const persisted = (await readPrivateJson<Round>(roundPath))!;
    // The racing write stands untouched — complete's write never ran.
    expect(persisted.status).toBe("Complete");
    expect(persisted.scoring).toBeUndefined();
    expect(updateRoundsIndex).not.toHaveBeenCalled();
    expect(recomputeSeason).not.toHaveBeenCalled();
  });

  // ── (c) Accounted-for gate ───────────────────────────────────────────────

  it("c1 an unaccounted Filled slot -> 409 PILOTS_NOT_ACCOUNTED_FOR, in-lease, before the config read", async () => {
    const ctx = await seedCompletable({ accounted: false });
    const roundBefore = await bytes(`rounds/${ctx.roundId}.json`);

    const res = await complete(ctx.admin, ctx.roundId);

    expect(res.status).toBe(409);
    expect(res.jsonBody).toEqual(unaccounted(ctx.pilotId));
    expect(await bytes(`rounds/${ctx.roundId}.json`)).toEqual(roundBefore);
    expect(updateRoundsIndex).not.toHaveBeenCalled();
    expect(recomputeSeason).not.toHaveBeenCalled();
    expect(withPrivateLeaseRenewing).toHaveBeenCalledTimes(1);
    expect(control.configReads).toBe(0);
  });

  it("c2 race toward accounted: the slot is accounted between the pre-read and the leased read -> 200", async () => {
    const ctx = await seedCompletable({ accounted: false });
    const roundPath = `rounds/${ctx.roundId}.json`;

    control.beforeLease = async (p) => {
      const r = (await readPrivateJson<Round>(p))!;
      await writePrivateJson(p, {
        ...r,
        teams: r.teams.map((t) => ({
          ...t,
          pilots: t.pilots.map((s) => ({ ...s, accountedFor: true })),
        })),
      });
    };

    const res = await complete(ctx.admin, ctx.roundId);

    expect(res.status).toBe(200);
    expect((await readPrivateJson<Round>(roundPath))?.status).toBe("Complete");
  });

  it("c3 race toward unaccounted: the slot flips between the pre-read and the leased read -> 409", async () => {
    const ctx = await seedCompletable();
    const roundPath = `rounds/${ctx.roundId}.json`;

    control.beforeLease = async (p) => {
      const r = (await readPrivateJson<Round>(p))!;
      await writePrivateJson(p, {
        ...r,
        teams: r.teams.map((t) => ({
          ...t,
          pilots: t.pilots.map((s) => ({ ...s, accountedFor: false })),
        })),
      });
    };

    const res = await complete(ctx.admin, ctx.roundId);

    expect(res.status).toBe(409);
    expect(res.jsonBody).toEqual(unaccounted(ctx.pilotId));
    const persisted = (await readPrivateJson<Round>(roundPath))!;
    expect(persisted.status).toBe("Locked");
    expect(persisted.scoring).toBeUndefined();
  });

  it("c4 a BriefComplete round with an unaccounted slot -> 409 CONFLICT (status gate precedes the accounted-for gate)", async () => {
    const ctx = await seedCompletable({ status: "BriefComplete", accounted: false });

    const res = await complete(ctx.admin, ctx.roundId);

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code?: string })?.code).toBe("CONFLICT");
  });

  // ── (d) Config ───────────────────────────────────────────────────────────

  it("d1 the config read fails -> 500 INTERNAL, round untouched", async () => {
    const ctx = await seedCompletable();
    const roundBefore = await bytes(`rounds/${ctx.roundId}.json`);

    control.onConfigRead = () => {
      throw Object.assign(new Error("transient config read failure"), {
        statusCode: 503,
      });
    };

    const res = await complete(ctx.admin, ctx.roundId);

    expect(res.status).toBe(500);
    expect(res.jsonBody).toEqual(INTERNAL_500);
    expect(await bytes(`rounds/${ctx.roundId}.json`)).toEqual(roundBefore);
    expect(updateRoundsIndex).not.toHaveBeenCalled();
    expect(recomputeSeason).not.toHaveBeenCalled();
  });

  // ── (e) Storage ──────────────────────────────────────────────────────────

  it("e1 the round write fails -> 500 INTERNAL, round untouched", async () => {
    const ctx = await seedCompletable();
    const roundBefore = await bytes(`rounds/${ctx.roundId}.json`);

    control.failRoundWrite = true;
    const res = await complete(ctx.admin, ctx.roundId);

    expect(res.status).toBe(500);
    expect(res.jsonBody).toEqual(INTERNAL_500);
    expect(await bytes(`rounds/${ctx.roundId}.json`)).toEqual(roundBefore);
    expect(updateRoundsIndex).not.toHaveBeenCalled();
    expect(recomputeSeason).not.toHaveBeenCalled();
  });

  it("e2 the round vanishes between the pre-read and the lease -> 404 NOT_FOUND", async () => {
    const ctx = await seedCompletable();

    control.beforeLease = async (p) => {
      await getPrivateContainer().getBlobClient(p).delete();
    };

    const res = await complete(ctx.admin, ctx.roundId);

    expect(res.status).toBe(404);
    expect(res.jsonBody).toEqual(NOT_FOUND);
    expect(updateRoundsIndex).not.toHaveBeenCalled();
    expect(recomputeSeason).not.toHaveBeenCalled();
  });

  it("e3 the republish fails -> 500 GENERIC_500, the Complete write stands, no recompute", async () => {
    const ctx = await seedCompletable();

    vi.mocked(updateRoundsIndex).mockRejectedValueOnce(new Error("index down"));

    const res = await complete(ctx.admin, ctx.roundId);

    expect(res.status).toBe(500);
    // The republish sits outside every try/catch, so its plain failure reaches
    // withErrorHandler's generic catch-all — lowercase, NOT the HttpError
    // shape.
    expect(res.jsonBody).toEqual(GENERIC_500);
    expect(
      (await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`))?.status,
    ).toBe("Complete");
    expect(recomputeSeason).not.toHaveBeenCalled();
  });

  // ── (f) Lease ────────────────────────────────────────────────────────────

  it("f1 the config read runs under the round lease", async () => {
    const ctx = await seedCompletable();
    const roundPath = `rounds/${ctx.roundId}.json`;
    const states: Array<string | undefined> = [];

    control.onConfigRead = async () => {
      states.push(await leaseState(roundPath));
    };

    const res = await complete(ctx.admin, ctx.roundId);

    expect(res.status).toBe(200);
    expect(states).toEqual(["leased"]);
  });

  // ── (g) Success path ─────────────────────────────────────────────────────

  it("g1 admin complete: 200, persisted Complete round with scoring, republish then recompute, budget 2 reads / 1 caller", async () => {
    const ctx = await seedCompletable();

    const { res, reads, callers } = await measure(ctx.admin, ctx.roundId);

    expect(res.status).toBe(200);
    const persisted = (await readPrivateJson<Round>(
      `rounds/${ctx.roundId}.json`,
    ))!;
    expect(res.jsonBody).toEqual(persisted);
    expect(persisted.status).toBe("Complete");
    expect(persisted.isLocked).toBe(false);
    expect(typeof persisted.scoring?.scoredAt).toBe("string");
    expect(persisted.scoring).toMatchObject({
      taskMaxPoints: expect.any(Number),
    });

    // rounds.json carries the new status.
    const index = await readPublicJson<Array<{ id: string; status: string }>>(
      "rounds.json",
    );
    expect(index?.find((entry) => entry.id === ctx.roundId)?.status).toBe(
      "Complete",
    );

    // Budget (vacuity guards first, then the targets).
    const limiter = vi.mocked(mutationRateLimit);
    expect(limiter).toHaveBeenCalledTimes(1);
    expect(limiter.mock.calls[0]?.[2]).toBe("completeRound");
    expect(limiter.mock.calls[0]?.[3]).toBe("heavy");
    expect(reads).toBeGreaterThanOrEqual(1);
    expect(callers).toBeGreaterThanOrEqual(1);
    expect.soft(callers).toBe(1);
    expect.soft(reads).toBe(2);

    // Lease: exactly one renewing lease, on the round blob.
    expect(withPrivateLeaseRenewing).toHaveBeenCalledTimes(1);
    expect(vi.mocked(withPrivateLeaseRenewing).mock.calls[0]?.[0]).toBe(
      `rounds/${ctx.roundId}.json`,
    );

    // Calls: republish carries the persisted round; recompute carries the year.
    expect(updateRoundsIndex).toHaveBeenCalledTimes(1);
    expect(updateRoundsIndex).toHaveBeenCalledWith(
      expect.objectContaining({ id: ctx.roundId, status: "Complete" }),
    );
    expect(recomputeSeason).toHaveBeenCalledTimes(1);
    expect(recomputeSeason).toHaveBeenCalledWith(ctx.year);

    // Order: the republish runs BEFORE the recompute is fired.
    expect(
      vi.mocked(updateRoundsIndex).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(recomputeSeason).mock.invocationCallOrder[0]);
  });

  it("g2 ?dryRun=true is ignored: complete has no preview and still completes", async () => {
    const ctx = await seedCompletable();

    const res = await complete(ctx.admin, ctx.roundId, { dryRun: "true" });

    expect(res.status).toBe(200);
    expect(
      (await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`))?.status,
    ).toBe("Complete");
  });

  // ── (h) Post-response containment ────────────────────────────────────────

  it("h1 a rejected recompute is logged and the response stands", async () => {
    const ctx = await seedCompletable();

    vi.mocked(recomputeSeason).mockRejectedValueOnce(
      new Error("recompute down"),
    );
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const res = await complete(ctx.admin, ctx.roundId);

    expect(res.status).toBe(200);
    expect(
      (await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`))?.status,
    ).toBe("Complete");
    const index = await readPublicJson<Array<{ id: string; status: string }>>(
      "rounds.json",
    );
    expect(index?.find((entry) => entry.id === ctx.roundId)?.status).toBe(
      "Complete",
    );
    await vi.waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith(
        `[completeRound] recomputeSeason(${ctx.year}) failed:`,
        expect.objectContaining({ message: "recompute down" }),
      ),
    );
  });

  it("h2 C4: a synchronous throw in post-response work is contained — 200, Complete, republished, logged", async () => {
    const ctx = await seedCompletable();

    vi.mocked(recomputeSeason).mockImplementationOnce(() => {
      throw new Error("sync recompute failure");
    });
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const res = await complete(ctx.admin, ctx.roundId);

    expect(res.status).toBe(200);
    expect(
      (await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`))?.status,
    ).toBe("Complete");
    const index = await readPublicJson<Array<{ id: string; status: string }>>(
      "rounds.json",
    );
    expect(index?.find((entry) => entry.id === ctx.roundId)?.status).toBe(
      "Complete",
    );
    await vi.waitFor(() => {
      const logged = errorSpy.mock.calls.some(
        ([first]) =>
          typeof first === "string" &&
          first.includes("post-response work failed after the write committed"),
      );
      expect(logged).toBe(true);
    });
  });

  it("h3 a never-settling recompute still lets the invoke resolve with 200", async () => {
    const ctx = await seedCompletable();

    vi.mocked(recomputeSeason).mockReturnValueOnce(
      new Promise<void>(() => undefined),
    );

    const res = await complete(ctx.admin, ctx.roundId);

    expect(res.status).toBe(200);
    expect(
      (await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`))?.status,
    ).toBe("Complete");
  });
});
