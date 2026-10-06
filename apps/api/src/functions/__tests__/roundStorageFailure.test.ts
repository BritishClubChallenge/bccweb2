// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * Characterization pin (issue #282, todo 1): a NON-404 storage failure on a
 * `rounds/{id}.json` read — a pre-read, a dry-run preview read, or the
 * plain-lease leased read — answers the capital-S HttpError 500 body
 * `{ error: "Internal Server Error", code: "INTERNAL" }`, never the lowercase
 * generic catch-all body. Written GREEN against the unchanged executor; the
 * round-record move must not change any of these bytes.
 *
 * Seam: wrap the REAL `readJson` and throw a single injected failure on the
 * NEXT read of the armed path. `control.failPath` is consumed by the throw,
 * so a case whose arming never fires fails on `control.failPath === null`
 * instead of passing vacuously. Arm AFTER seeding: `seedRoundAt`/`makeUser`
 * drive real handlers that read `rounds/…` blobs themselves. confirmRound
 * needs no counter: the plain `round` strategy's only read of the request is
 * the leased one (roundTransitions.ts, runRoundWrite), so arming the path
 * fails exactly that read.
 */
import { randomUUID } from "node:crypto";
import type { HttpResponseInit } from "@azure/functions";
import type { Round, RoundStatus, User } from "@bccweb/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  invoke,
  makeAuthRequest,
} from "../../__tests__/helpers/api.js";
import {
  makeRound,
  makeUser,
  readPrivateJson,
  writePrivateJson,
} from "../../__tests__/helpers/seed.js";
import { resetAllBuckets } from "../../lib/rateLimit.js";

const control = vi.hoisted(() => ({ failPath: null as null | string }));

vi.mock("../../lib/blobJson.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/blobJson.js")>();
  return {
    ...actual,
    readJson: vi.fn(
      async (
        client: Parameters<typeof actual.readJson>[0],
        schema: Parameters<typeof actual.readJson>[1],
        path: Parameters<typeof actual.readJson>[2],
      ) => {
        if (control.failPath !== null && path === control.failPath) {
          control.failPath = null;
          throw Object.assign(new Error("injected storage failure"), {
            statusCode: 503,
          });
        }
        return actual.readJson(client, schema, path);
      },
    ),
  };
});

import "../roundsMutate.js";

/** `requestId` is undefined under the test ctx, and toEqual ignores undefined. */
const CAPITAL_500 = { error: "Internal Server Error", code: "INTERNAL" };

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

beforeEach(() => {
  control.failPath = null;
  resetAllBuckets();
});

interface FailureCase {
  /** Registered handler name in roundsMutate.ts. */
  readonly handler: string;
  /** The status to seed the round at (the transition's `from`). */
  readonly status: RoundStatus;
  /** Extra request init beyond `{ method: "POST", params: { id } }`. */
  readonly query?: Record<string, string>;
}

const CASES: ReadonlyArray<readonly [string, FailureCase]> = [
  // The plain `round` strategy has no pre-read: this is the LEASED read.
  ["confirmRound", { handler: "confirmRound", status: "Proposed" }],
  // The dry-run preview's unleased read (the plain strategy's preview branch).
  [
    "reopenBrief",
    {
      handler: "reopenBrief",
      status: "BriefComplete",
      query: { dryRun: "true" },
    },
  ],
  // roundAndBrief: the unleased pre-read.
  ["briefCompleteRound", { handler: "briefCompleteRound", status: "Confirmed" }],
  // roundAndBriefRollback: the unleased pre-read.
  ["lockRound", { handler: "lockRound", status: "BriefComplete" }],
  // roundRenewing: the unleased pre-read.
  ["completeRound", { handler: "completeRound", status: "Locked" }],
  // pureTrackEchoes: the unleased pre-read (the delegated call is never reached).
  ["unlockRound", { handler: "unlockRound", status: "Locked" }],
];

async function callFailing(
  c: FailureCase,
  user: Pick<User, "id" | "email">,
  id: string,
): Promise<HttpResponseInit> {
  control.failPath = `rounds/${id}.json`;
  return invoke(
    c.handler,
    makeAuthRequest(user.id, user.email, {
      method: "POST",
      params: { id },
      ...(c.query ? { query: c.query } : {}),
    }),
  );
}

describe("a non-404 storage failure on a round read answers the capital-S 500 (issue 282)", () => {
  it.each(CASES)(
    "%s -> 500 { error: \"Internal Server Error\", code: \"INTERNAL\" }",
    async (_name, c) => {
      const { round } = await seedRoundAt(c.status);
      const { user } = await makeUser({ roles: ["Admin"] });

      const res = await callFailing(c, user, round.id);

      expect(res.status).toBe(500);
      expect(res.jsonBody).toEqual(CAPITAL_500);
      // The injection actually fired — a case that never hit the armed read
      // would otherwise pass vacuously on a later 500.
      expect(control.failPath).toBeNull();
    },
  );
});
