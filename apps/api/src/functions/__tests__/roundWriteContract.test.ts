// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HttpResponseInit } from "@azure/functions";
import type { Round, RoundStatus, User } from "@bccweb/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  invoke,
  makeAuthRequest,
  makeRequest,
} from "../../__tests__/helpers/api.js";
import { getPrivateContainer } from "../../__tests__/helpers/azurite.js";
import {
  makeRound,
  makeUser,
  readPrivateJson,
  writePrivateJson,
} from "../../__tests__/helpers/seed.js";
import { mutationRateLimit, resetAllBuckets } from "../../lib/rateLimit.js";

// ─── Shared scaffolding (todos 1-6 build on this) ─────────────────────────────

// Wraps the REAL mutationRateLimit — a bare vi.mock here would stop the bucket
// from charging and hide a double charge. Fixtures charge the limiter too
// (seed.ts drives the real createRound handler), so `call()` clears the mock
// after fixture setup and before invoke.
vi.mock("../../lib/rateLimit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/rateLimit.js")>();
  return { ...actual, mutationRateLimit: vi.fn(actual.mutationRateLimit) };
});

// While `failRoundWrites` is set, round blob writes fail — used to prove the
// executor maps an arbitrary storage failure to the generic 500 body. Pattern
// copied from roundsMutate.lock.test.ts:20-40.
const roundWriteControl = vi.hoisted(() => ({ failRoundWrites: false }));
vi.mock("../../lib/blobJson.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/blobJson.js")>();
  return {
    ...actual,
    writePrivateJson: vi.fn(
      async (
        path: Parameters<typeof actual.writePrivateJson>[0],
        ...rest: ReadonlyArray<unknown>
      ) => {
        if (path.startsWith("rounds/") && roundWriteControl.failRoundWrites) {
          throw new Error("injected round write failure");
        }
        return (actual.writePrivateJson as (...a: ReadonlyArray<unknown>) => unknown)(
          path,
          ...rest,
        );
      },
    ),
  };
});

// Namespace lookup so this file typechecks before ROUND_WRITES exists.
import * as roundTransitionsModule from "../../lib/roundTransitions.js";
import "../roundsMutate.js";

const writes = (roundTransitionsModule as unknown as Record<string, unknown>)[
  "ROUND_WRITES"
] as Record<string, unknown> | undefined;

// ─── Exact response bodies ────────────────────────────────────────────────────
// `requestId` is undefined under the test ctx, and toEqual ignores undefined.

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
const GENERIC_500 = { error: "Internal server error", code: "INTERNAL" };
const INVALID_BLOB_PATH = {
  error: "Bad Request",
  code: "INVALID_BLOB_PATH",
  detail: "Invalid blob path",
};

// ─── Source-reading structural helpers ────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUNDS_MUTATE_SOURCE = await fs.readFile(
  path.resolve(HERE, "..", "roundsMutate.ts"),
  "utf8",
);
const ROUND_TRANSITIONS_SOURCE = await fs.readFile(
  path.resolve(HERE, "..", "..", "lib", "roundTransitions.ts"),
  "utf8",
);

/** The body of one handler function, up to the next top-level construct. */
function handlerSource(src: string, name: string): string {
  const start = src.search(
    new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, "m"),
  );
  if (start < 0) throw new Error(`handler ${name} not found`);
  const rest = src.slice(start);
  const end = rest
    .slice(1)
    .search(/^(export )?(async )?function |^\/\/ ─── |^app\.http\(/m);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

const PREAMBLE_TOKENS = [
  "getCallerIdentity(",
  "unauthorizedResponse(",
  "forbiddenResponse(",
  "isCoord(",
  "assertCanManageRound(",
  "assertManageableRound(",
  "mutationRateLimit(",
  "updateRoundsIndex(",
  "withPrivateLease",
  "withRoundAndBriefLease(",
  "mutatePureTrackEchoes(",
  "req.params",
  '"Round not found"',
  "MISSING_ROUND_ID",
];

// ─── Fixtures and invocation ──────────────────────────────────────────────────

/**
 * Seed a round parked at `status`. Forced by a direct blob write because
 * `makeRound` reaches its statuses through `transitionRound` (seed.ts:377) —
 * the very machinery under test. The eager brief already exists from
 * createRound.
 */
async function seedRoundAt(
  status: RoundStatus,
  clubId = randomUUID(),
): Promise<{ round: Round; clubId: string }> {
  const created = await makeRound({
    organisingClubId: clubId,
    organisingClubName: "Test Club",
  });
  const round = await readPrivateJson<Round>(`rounds/${created.id}.json`);
  if (!round) throw new Error(`Round ${created.id} missing`);
  round.status = status;
  // Production sets isLocked at Locked and nowhere else; a fixture that lied
  // about it would be a trap for the next reader.
  round.isLocked = status === "Locked";
  await writePrivateJson(`rounds/${created.id}.json`, round);
  return { round, clubId };
}

async function bytes(path: string): Promise<Buffer> {
  return getPrivateContainer().getBlobClient(path).downloadToBuffer();
}

async function etag(path: string): Promise<string | undefined> {
  return (await getPrivateContainer().getBlobClient(path).getProperties())
    .etag;
}

/**
 * Invoke a registered handler, clearing the limiter spy AFTER fixture setup:
 * makeRound/makeUser drive real handlers that charge the limiter
 * (seed.ts:347-359), so every limiter-once assertion goes through here.
 * Saturated-bucket cases instead call saturateOwnBucket and then
 * invokeEvidenceHandler directly, with no clear or reset in between.
 */
async function call(
  handler: string,
  user: Pick<User, "id" | "email"> | null,
  init: {
    method?: string;
    params?: Record<string, string>;
    query?: Record<string, string>;
    body?: unknown;
  } = {},
): Promise<HttpResponseInit> {
  const req = user
    ? makeAuthRequest(user.id, user.email, init)
    : makeRequest(init);
  vi.mocked(mutationRateLimit).mockClear();
  return invoke(handler, req);
}

// Silence the unused scaffolding warnings for helpers later todos consume.
void bytes;
void etag;
void UNAUTHORIZED;
void SCOPE_FORBIDDEN;
void NOT_FOUND;
void INVALID_BLOB_PATH;

beforeEach(() => {
  roundWriteControl.failRoundWrites = false;
  resetAllBuckets();
});

// ─── (a) Structural: handlers delegate to applyRoundWrite ─────────────────────

describe("round write handlers delegate to applyRoundWrite (issue 277)", () => {
  it.each(["confirmRound", "cancelRound", "uncancelRound"])(
    "%s contains applyRoundWrite( and none of the preamble tokens",
    (name) => {
      const body = handlerSource(ROUNDS_MUTATE_SOURCE, name);
      expect(body).toContain("applyRoundWrite(");
      for (const token of PREAMBLE_TOKENS) {
        expect(body).not.toContain(token);
      }
    },
  );
});

// ─── (b) The ROUND_WRITES table rows ──────────────────────────────────────────

describe("ROUND_WRITES table rows (issue 277)", () => {
  it("confirm row", () => {
    expect(writes?.["confirm"]).toEqual({
      kind: "transition",
      from: ["Proposed"],
      to: "Confirmed",
      lease: "round",
      endpoint: "confirmRound",
      tier: "standard",
    });
  });

  it("reopen row", () => {
    expect(writes?.["reopen"]).toEqual({
      kind: "transition",
      from: ["BriefComplete"],
      to: "Confirmed",
      lease: "round",
      endpoint: "reopenBrief",
      tier: "standard",
    });
  });

  it("cancel row", () => {
    expect(writes?.["cancel"]).toEqual({
      kind: "transition",
      from: ["Proposed", "Confirmed"],
      to: "Cancelled",
      lease: "round",
      endpoint: "cancelRound",
      tier: "standard",
    });
  });

  it("uncancel row", () => {
    expect(writes?.["uncancel"]).toEqual({
      kind: "transition",
      from: ["Cancelled"],
      to: "Proposed",
      lease: "round",
      endpoint: "uncancelRound",
      tier: "standard",
    });
  });
});

// ─── (c) Single-occurrence rules in the executor module ───────────────────────

describe("roundTransitions.ts keeps the shared pieces single (issue 277)", () => {
  it.each([
    "mutationRateLimit(req, caller, spec.endpoint, spec.tier)",
    "getCallerIdentity(",
    "updateRoundsIndex(",
    '"Round not found"',
    '"MISSING_ROUND_ID"',
  ])("contains exactly one occurrence of %s", (needle) => {
    expect(ROUND_TRANSITIONS_SOURCE.split(needle).length - 1).toBe(1);
  });
});

// ─── (d) Behavioural baseline: admin confirm charges the limiter once ─────────

describe("round write executor behaviour (issue 277)", () => {
  it("admin confirm on a Proposed round returns 200 and charges confirmRound/standard once", async () => {
    const { round } = await seedRoundAt("Proposed");
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await call("confirmRound", user, {
      method: "POST",
      params: { id: round.id },
    });

    expect(res.status).toBe(200);
    const limiter = vi.mocked(mutationRateLimit);
    expect(limiter).toHaveBeenCalledTimes(1);
    expect(limiter.mock.calls[0]?.[2]).toBe("confirmRound");
    expect(limiter.mock.calls[0]?.[3]).toBe("standard");
  });
});

// ─── (e) createRound contract (todo 2) ────────────────────────────────────────

describe("createRound responses (issue 277)", () => {
  it("unauthenticated -> 401 UNAUTHORIZED", async () => {
    const seeded = await makeRound();
    const res = await call("createRound", null, {
      method: "POST",
      body: {
        date: "2026-06-01",
        siteId: seeded.site.id,
        seasonYear: seeded.season.year,
      },
    });
    expect(res.status).toBe(401);
    expect(res.jsonBody).toEqual(UNAUTHORIZED);
  });

  it("Pilot -> 403 FORBIDDEN", async () => {
    const seeded = await makeRound();
    const { user } = await makeUser({ roles: ["Pilot"] });
    const res = await call("createRound", user, {
      method: "POST",
      body: {
        date: "2026-06-01",
        siteId: seeded.site.id,
        seasonYear: seeded.season.year,
      },
    });
    expect(res.status).toBe(403);
    expect(res.jsonBody).toEqual(FORBIDDEN);
  });

  it("RoundsCoord with no club -> 403 FORBIDDEN with no detail", async () => {
    const seeded = await makeRound();
    const { user } = await makeUser({ roles: ["RoundsCoord"], clubId: null });
    const res = await call("createRound", user, {
      method: "POST",
      body: {
        date: "2026-06-01",
        siteId: seeded.site.id,
        seasonYear: seeded.season.year,
      },
    });
    expect(res.status).toBe(403);
    expect(res.jsonBody).toEqual(FORBIDDEN);
  });

  it("RoundsCoord of club A posting organisingClubId B -> 403 FORBIDDEN with no detail", async () => {
    const seeded = await makeRound();
    const clubA = randomUUID();
    const { user } = await makeUser({ roles: ["RoundsCoord"], clubId: clubA });
    const res = await call("createRound", user, {
      method: "POST",
      body: {
        date: "2026-06-01",
        siteId: seeded.site.id,
        seasonYear: seeded.season.year,
        organisingClubId: randomUUID(),
      },
    });
    expect(res.status).toBe(403);
    expect(res.jsonBody).toEqual(FORBIDDEN);
  });

  it("malformed JSON -> 500 GENERIC_500", async () => {
    const seeded = await makeRound();
    const { user } = await makeUser({ roles: ["Admin"] });
    const req = makeAuthRequest(user.id, user.email, { method: "POST" });
    req.json = () => Promise.reject(new SyntaxError("Unexpected token"));
    vi.mocked(mutationRateLimit).mockClear();
    const res = await invoke("createRound", req);
    expect(res.status).toBe(500);
    expect(res.jsonBody).toEqual(GENERIC_500);
    void seeded;
  });

  it("Admin posting status: \"Locked\" -> 400 INVALID_STATUS", async () => {
    const seeded = await makeRound();
    const { user } = await makeUser({ roles: ["Admin"] });
    const res = await call("createRound", user, {
      method: "POST",
      body: {
        date: "2026-06-01",
        siteId: seeded.site.id,
        seasonYear: seeded.season.year,
        status: "Locked",
      },
    });
    expect(res.status).toBe(400);
    expect(res.jsonBody).toEqual({
      error: "Bad Request",
      code: "INVALID_STATUS",
      detail: "Rounds must be created with status Proposed (received Locked)",
    });
  });

  it("Admin valid create -> 201 and charges createRound/standard once", async () => {
    const seeded = await makeRound();
    const { user } = await makeUser({ roles: ["Admin"] });
    const res = await call("createRound", user, {
      method: "POST",
      body: {
        date: "2026-06-01",
        siteId: seeded.site.id,
        seasonYear: seeded.season.year,
      },
    });
    expect(res.status).toBe(201);
    const limiter = vi.mocked(mutationRateLimit);
    expect(limiter).toHaveBeenCalledTimes(1);
    expect(limiter.mock.calls[0]?.[2]).toBe("createRound");
    expect(limiter.mock.calls[0]?.[3]).toBe("standard");
  });

  it("structural: createRound passes the preamble check and contains applyRoundWrite(", () => {
    const body = handlerSource(ROUNDS_MUTATE_SOURCE, "createRound");
    expect(body).toContain("applyRoundWrite(");
    for (const token of PREAMBLE_TOKENS) {
      expect(body).not.toContain(token);
    }
  });

  it("structural: ROUND_WRITES.create equals its row", () => {
    expect(writes?.["create"]).toEqual({
      kind: "create",
      endpoint: "createRound",
      tier: "standard",
    });
  });
});

// ─── (f) createRound concurrency regression (todo 2 review fix) ───────────────

/**
 * A controllable deferred so the test can hold one invocation's `scope` open
 * while another runs to completion — the exact interleave that exposes shared
 * module-level hook state.
 */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("createRound concurrent invocations stay isolated (issue 277)", () => {
  it("two interleaved creates each persist their OWN body, not the other's", async () => {
    // Two fixtures → two distinct existing sites (and the shared season year).
    const fixtureA = await makeRound();
    const fixtureB = await makeRound();
    const { user } = await makeUser({ roles: ["Admin"] });

    const bodyA = {
      date: "2026-06-01",
      siteId: fixtureA.site.id,
      seasonYear: fixtureA.season.year,
    };
    const bodyB = {
      date: "2026-07-02",
      siteId: fixtureB.site.id,
      seasonYear: fixtureB.season.year,
    };

    // Park A INSIDE the rate limiter — after its scope has assigned body=A but
    // before mutate reads it. The limiter is the one await between scope and
    // mutate that we can intercept (it is the wrapped mock above). We identify
    // A by a unique x-forwarded-for marker; B's limiter call passes straight
    // through. Frozen this way, B's scope overwrites the shared module-level
    // body (the bug) before A's mutate reads it — so A would build round A from
    // B's body. With per-invocation closures, A's own binding is untouched.
    const markerA = `${randomUUID()}.raceA`;
    const aInLimiter = deferred<void>();
    const releaseA = deferred<void>();
    const limiter = vi.mocked(mutationRateLimit);
    const realLimiter = limiter.getMockImplementation()!;
    limiter.mockImplementation(async (req, caller, endpoint, tier) => {
      if (req.headers.get("x-forwarded-for") === markerA) {
        aInLimiter.resolve();
        await releaseA.promise;
      }
      return realLimiter(req, caller, endpoint, tier);
    });

    try {
      const reqA = makeAuthRequest(user.id, user.email, {
        method: "POST",
        body: bodyA,
        headers: { "x-forwarded-for": markerA },
      });
      const reqB = makeAuthRequest(user.id, user.email, {
        method: "POST",
        body: bodyB,
        headers: { "x-forwarded-for": `${randomUUID()}.raceB` },
      });

      // Start A (do not await); wait until it is parked in the limiter — its
      // scope has already assigned body=A.
      const resAPromise = invoke("createRound", reqA);
      await aInLimiter.promise;
      // Run B to FULL completion while A is frozen — under the bug B's scope
      // overwrites the shared body to B.
      const resB = await invoke("createRound", reqB);
      // Release A; its mutate now reads `body`.
      releaseA.resolve();
      const resA = await resAPromise;

      expect(resB.status).toBe(201);
      expect(resA.status).toBe(201);

      const roundA = resA.jsonBody as Round;
      const roundB = resB.jsonBody as Round;
      // Each round must carry ITS OWN request's site/date — never the sibling's.
      expect(roundA.site.id).toBe(bodyA.siteId);
      expect(roundA.date).toBe(bodyA.date);
      expect(roundB.site.id).toBe(bodyB.siteId);
      expect(roundB.date).toBe(bodyB.date);
      // And the persisted blobs agree with what was returned.
      const persistedA = await readPrivateJson<Round>(`rounds/${roundA.id}.json`);
      const persistedB = await readPrivateJson<Round>(`rounds/${roundB.id}.json`);
      expect(persistedA?.site.id).toBe(bodyA.siteId);
      expect(persistedA?.date).toBe(bodyA.date);
      expect(persistedB?.site.id).toBe(bodyB.siteId);
      expect(persistedB?.date).toBe(bodyB.date);
    } finally {
      limiter.mockImplementation(realLimiter);
    }
  });
});
