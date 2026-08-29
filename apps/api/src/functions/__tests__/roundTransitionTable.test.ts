// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * Characterization matrix for the four pure status transitions
 * (confirm / reopen / cancel / uncancel) — issue #274.
 *
 * This file encodes what the handlers do TODAY so the round-transition refactor
 * cannot change it. Every cell is derived from ONE `as const` table, so a spec
 * change shows up as a table diff rather than as a hand-edited assertion.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import type { HttpResponseInit } from "@azure/functions";
import { ROUND_STATUSES } from "@bccweb/types";
import type { Round, RoundStatus, RoundSummary, User } from "@bccweb/types";
import { makeAuthRequest, makeRequest, invoke } from "../../__tests__/helpers/api.js";
import { resetAllBuckets } from "../../lib/rateLimit.js";
import {
  makeUser,
  makeRound,
  readPrivateJson,
  readPublicJson,
  writePrivateJson,
} from "../../__tests__/helpers/seed.js";
import "../roundsMutate.js";

// ─── The pinned spec ──────────────────────────────────────────────────────────

/**
 * The four transitions, verbatim from their `transition(...)` call sites:
 * roundsMutate.ts:509, :828, :1347, :1372. `allowedFrom` order matters — it is
 * joined into the 409 detail (roundsMutate.ts:474).
 *
 * `invalidatedSignatureCount` is the extra 200-body key each handler is
 * contracted to emit: reopenBrief alone carries it (always 0,
 * roundsMutate.ts:832); `null` means the key must be ABSENT.
 */
const TRANSITION_SPECS = [
  {
    handler: "confirmRound",
    allowedFrom: ["Proposed"],
    to: "Confirmed",
    invalidatedSignatureCount: null,
  },
  {
    handler: "reopenBrief",
    allowedFrom: ["BriefComplete"],
    to: "Confirmed",
    invalidatedSignatureCount: 0,
  },
  {
    handler: "cancelRound",
    allowedFrom: ["Proposed", "Confirmed"],
    to: "Cancelled",
    invalidatedSignatureCount: null,
  },
  {
    handler: "uncancelRound",
    allowedFrom: ["Cancelled"],
    to: "Proposed",
    invalidatedSignatureCount: null,
  },
] as const;

/** The exact 409 detail built by `transition()` — roundsMutate.ts:474. */
function conflictDetail(allowedFrom: readonly RoundStatus[], actual: RoundStatus): string {
  return `Expected status ${allowedFrom.join(" or ")}, got ${actual}`;
}

// Every handler × every round status. Legality is decided by THIS file's
// `allowedFrom`, never by re-reading the handler, so a widened or narrowed gate
// in the source fails a cell here.
const MATRIX = TRANSITION_SPECS.flatMap((spec) =>
  ROUND_STATUSES.map((from) => ({
    spec,
    from,
    legal: spec.allowedFrom.some((allowed) => allowed === from),
  })),
);

const LEGAL_CELLS = MATRIX.filter((cell) => cell.legal).map(
  (cell) => [`${cell.spec.handler} from ${cell.from} → ${cell.spec.to}`, cell.spec, cell.from] as const,
);

const ILLEGAL_CELLS = MATRIX.filter((cell) => !cell.legal).map(
  (cell) => [`${cell.spec.handler} from ${cell.from}`, cell.spec, cell.from] as const,
);

const AUTH_CELLS = TRANSITION_SPECS.map((spec) => [spec.handler, spec] as const);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function errorBody(res: HttpResponseInit): { code?: string; detail?: string } {
  return (res.jsonBody ?? {}) as { code?: string; detail?: string };
}

async function readRound(id: string): Promise<Round> {
  const round = await readPrivateJson<Round>(`rounds/${id}.json`);
  if (!round) throw new Error(`Round ${id} missing`);
  return round;
}

async function publicStatus(id: string): Promise<RoundStatus | undefined> {
  const index = await readPublicJson<RoundSummary[]>("rounds.json");
  return index?.find((summary) => summary.id === id)?.status;
}

/**
 * Seed a round parked at `status`. The status is forced by a direct blob write
 * because `makeRound` reaches its statuses through `transitionRound`
 * (seed.ts:377) — the very machinery under test — and its handlers demand a
 * full roster snapshot these fixtures deliberately skip.
 */
async function seedRoundAt(
  status: RoundStatus,
  overrides: { clubId?: string } = {},
): Promise<{ round: Round; clubId: string }> {
  const clubId = overrides.clubId ?? randomUUID();

  const created = await makeRound({
    organisingClubId: clubId,
    organisingClubName: "Test Club",
  });

  const round = await readRound(created.id);
  round.status = status;
  // Production sets isLocked at Locked and nowhere else (completeRound clears it,
  // roundsMutate.ts:1457). None of these four transitions read isLocked, but a
  // fixture that lied about it would be a trap for the next reader.
  round.isLocked = status === "Locked";
  await writePrivateJson(`rounds/${created.id}.json`, round);

  return { round, clubId };
}

function post(
  user: Pick<User, "id" | "email">,
  handler: string,
  params: Record<string, string>,
): Promise<HttpResponseInit> {
  return invoke(handler, makeAuthRequest(user.id, user.email, { method: "POST", params }));
}

// ─── The matrix ───────────────────────────────────────────────────────────────

describe("round transitions — the legal matrix (issue 274)", () => {
  beforeEach(() => resetAllBuckets());

  it("covers all 4 handlers × 6 statuses, 5 of them legal", () => {
    expect(MATRIX).toHaveLength(TRANSITION_SPECS.length * ROUND_STATUSES.length);
    expect(MATRIX).toHaveLength(24);
    expect(LEGAL_CELLS).toHaveLength(5);
    expect(ILLEGAL_CELLS).toHaveLength(19);
  });

  it.each(LEGAL_CELLS)(
    "%s: 200, status persisted, republished to rounds.json",
    async (_title, spec, from) => {
      const { round } = await seedRoundAt(from);
      const { user } = await makeUser({ roles: ["Admin"] });

      const res = await post(user, spec.handler, { id: round.id });

      expect(res.status).toBe(200);
      const body = (res.jsonBody ?? {}) as {
        status?: RoundStatus;
        invalidatedSignatureCount?: number;
      };
      expect(body.status).toBe(spec.to);
      // reopenBrief's 200 body is the round PLUS invalidatedSignatureCount — an
      // external contract the other three must NOT grow.
      expect(body.invalidatedSignatureCount).toBe(spec.invalidatedSignatureCount ?? undefined);

      expect((await readRound(round.id)).status).toBe(spec.to);
      // updateRoundsIndex effect (recompute.ts:51) — the public blob must follow.
      expect(await publicStatus(round.id)).toBe(spec.to);
    },
  );
});

describe("round transitions — every other source status is rejected (issue 274)", () => {
  beforeEach(() => resetAllBuckets());

  it.each(ILLEGAL_CELLS)(
    "%s: 409 CONFLICT naming the allowed statuses, round untouched",
    async (_title, spec, from) => {
      const { round } = await seedRoundAt(from);
      const { user } = await makeUser({ roles: ["Admin"] });

      const res = await post(user, spec.handler, { id: round.id });

      expect(res.status).toBe(409);
      expect(errorBody(res).code).toBe("CONFLICT");
      expect(errorBody(res).detail).toBe(conflictDetail(spec.allowedFrom, from));
      expect((await readRound(round.id)).status).toBe(from);
    },
  );
});

// ─── Auth and addressing ──────────────────────────────────────────────────────
//
// Each cell seeds the round at a status the handler WOULD accept, so a gate that
// leaks shows up as a 200 plus a moved status rather than as a silent pass.

describe("round transitions — auth (issue 274)", () => {
  beforeEach(() => resetAllBuckets());

  it.each(AUTH_CELLS)("%s: unauthenticated → 401 UNAUTHORIZED", async (_title, spec) => {
    const from = spec.allowedFrom[0];
    const { round } = await seedRoundAt(from);

    const res = await invoke(
      spec.handler,
      makeRequest({ method: "POST", params: { id: round.id } }),
    );

    expect(res.status).toBe(401);
    expect(errorBody(res).code).toBe("UNAUTHORIZED");
    expect((await readRound(round.id)).status).toBe(from);
  });

  it.each(AUTH_CELLS)("%s: a Pilot caller → 403 FORBIDDEN", async (_title, spec) => {
    const from = spec.allowedFrom[0];
    const { round } = await seedRoundAt(from);
    const { user } = await makeUser({ roles: ["Pilot"] });

    const res = await post(user, spec.handler, { id: round.id });

    expect(res.status).toBe(403);
    expect(errorBody(res).code).toBe("FORBIDDEN");
    expect((await readRound(round.id)).status).toBe(from);
  });

  it.each(AUTH_CELLS)(
    "%s: a RoundsCoord from another club → 403 FORBIDDEN",
    async (_title, spec) => {
      const from = spec.allowedFrom[0];
      const { round } = await seedRoundAt(from);
      const { user } = await makeUser({ roles: ["RoundsCoord"], clubId: randomUUID() });

      const res = await post(user, spec.handler, { id: round.id });

      expect(res.status).toBe(403);
      expect(errorBody(res).code).toBe("FORBIDDEN");
      expect(errorBody(res).detail).toBe("You can only manage rounds organised by your club");
      expect((await readRound(round.id)).status).toBe(from);
    },
  );
});

describe("round transitions — addressing (issue 274)", () => {
  beforeEach(() => resetAllBuckets());

  // Two DISTINCT failures. A missing route param is a caller error caught before
  // any blob read; a well-formed id for a round that is not there is a lookup
  // miss raised by assertManageableRound's readJson (roundsMutate.ts:103).
  it.each(AUTH_CELLS)("%s: absent round id → 400 MISSING_ROUND_ID", async (_title, spec) => {
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await invoke(
      spec.handler,
      makeAuthRequest(user.id, user.email, { method: "POST" }),
    );

    expect(res.status).toBe(400);
    expect(errorBody(res).code).toBe("MISSING_ROUND_ID");
    expect(errorBody(res).detail).toBe("Missing round id");
  });

  it.each(AUTH_CELLS)("%s: unknown round id → 404 NOT_FOUND", async (_title, spec) => {
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await post(user, spec.handler, { id: randomUUID() });

    expect(res.status).toBe(404);
    expect(errorBody(res).code).toBe("NOT_FOUND");
    expect(errorBody(res).detail).toBe("Round not found");
  });
});
