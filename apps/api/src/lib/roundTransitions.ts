// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * The four PURE round status transitions — confirm / reopen / cancel /
 * uncancel (issue #274).
 *
 * "Pure" means the whole mutation is `round.status = to`: no snapshotting, no
 * scoring, no brief work. Everything that distinguishes one from another is
 * DATA (`ROUND_TRANSITIONS`), so a new transition is a table row, not a fifth
 * copy of the same 20 lines. Handlers that do extra work — brief-complete,
 * lock, unlock, complete — deliberately stay in `functions/roundsMutate.ts`.
 *
 * Ordering: `applyRoundTransition` reads `rounds/{id}.json` ONCE and resolves
 * the caller ONCE, which is why `mutationRateLimit` runs INSIDE the lease. See
 * the comment at the call itself before moving it.
 */

import type { HttpRequest } from "@azure/functions";
import type { Round, RoundStatus } from "@bccweb/types";
import { RoundSchema } from "@bccweb/schemas";
import { getCallerIdentity } from "./auth.js";
import { getPrivateBlobClient, withPrivateLease } from "./blob.js";
import { readJson, writePrivateJson } from "./blobJson.js";
import { HttpError } from "./http.js";
import { mutationRateLimit, type MutationRateLimitTier } from "./rateLimit.js";
import { updateRoundsIndex } from "./recompute.js";
import { assertCanManageRound, isCoord } from "./roundAuth.js";

export interface RoundTransitionSpec {
  /** Statuses the transition accepts; anything else is a 409. */
  readonly from: readonly RoundStatus[];
  readonly to: RoundStatus;
  /** Rate-limit bucket key suffix — `mutation:{tier}:{endpoint}`. */
  readonly endpoint: string;
  readonly tier: MutationRateLimitTier;
}

export type RoundTransitionName = "confirm" | "reopen" | "cancel" | "uncancel";

/**
 * The transition matrix. `apps/api/src/functions/__tests__/issue8EvidenceHarness.ts`
 * derives its rate-limit evidence rows from this table rather than re-listing
 * them, so `endpoint`/`tier` here ARE the audited call sites.
 *
 * Do NOT write `as const satisfies Record<string, RoundTransitionSpec>`: `as
 * const` narrows `from` to e.g. `readonly ["Proposed"]`, and
 * `spec.from.includes(round.status)` below then fails to compile (TS2345).
 */
export const ROUND_TRANSITIONS: Record<
  RoundTransitionName,
  RoundTransitionSpec
> = {
  confirm: { from: ["Proposed"], to: "Confirmed", endpoint: "confirmRound", tier: "standard" },
  reopen: { from: ["BriefComplete"], to: "Confirmed", endpoint: "reopenBrief", tier: "standard" },
  cancel: { from: ["Proposed", "Confirmed"], to: "Cancelled", endpoint: "cancelRound", tier: "standard" },
  uncancel: { from: ["Cancelled"], to: "Proposed", endpoint: "uncancelRound", tier: "standard" },
};

/**
 * The exact 409 detail. Exported so reopenBrief's dryRun preview cannot drift
 * from the real path.
 */
export function expectedStatusDetail(
  from: readonly RoundStatus[],
  actual: RoundStatus
): string {
  return `Expected status ${from.join(" or ")}, got ${actual}`;
}

/**
 * Run one table-driven transition end to end: auth, scope, rate limit, status
 * gate, leased write, and the public-index republish. Returns the updated
 * round; every rejection is a thrown `HttpError`, so callers just wrap the
 * result in a 200.
 *
 * Response codes, in the order they can fire: 400 (no id) → 401 → 403 (coarse
 * role) → 404 (no such round) → 403 (wrong club) → 429 → 409 (wrong status).
 */
export async function applyRoundTransition(
  req: HttpRequest,
  name: RoundTransitionName
): Promise<Round> {
  const spec = ROUND_TRANSITIONS[name];

  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_ROUND_ID", "Missing round id");

  const caller = await getCallerIdentity(req);
  if (!caller) throw new HttpError(401, "UNAUTHORIZED");
  if (!isCoord(caller.roles)) throw new HttpError(403, "FORBIDDEN");

  const path = `rounds/${id}.json`;
  let updated: Round;

  try {
    updated = await withPrivateLease(path, async (leaseId) => {
      // The ONLY read of the round in this request. A 404 here is impossible:
      // acquireLease (blob.ts:306-313) already ran and threw for a missing
      // blob, and the catch below maps it.
      const round = await readJson(getPrivateBlobClient(path), RoundSchema, path);

      // Fine-grained scope, 403 — step 3 of rateLimit.ts:138-164.
      assertCanManageRound(caller, round);

      // DELIBERATELY INSIDE THE LEASE — do not hoist this into the handler.
      // rateLimit.ts:138-164 requires the scope check to resolve BEFORE the
      // limiter ("a forbidden caller must get 403, never 429"), and the scope
      // check needs the round. Reading the round once means the scope check
      // happens under the lease, so the limiter must follow it here. This is
      // safe because withLeaseOnClient releases in a `finally` (blob.ts:319-331),
      // so the 429/409 thrown below still frees the lease. The limiter itself is
      // a synchronous in-memory token bucket (rateLimit.ts:166-179) and issues
      // no I/O, so it does not extend the hold in any measurable way.
      await mutationRateLimit(req, caller, spec.endpoint, spec.tier);

      if (!spec.from.includes(round.status)) {
        throw new HttpError(
          409,
          "CONFLICT",
          expectedStatusDetail(spec.from, round.status)
        );
      }

      round.status = spec.to;
      await writePrivateJson(path, RoundSchema, round, leaseId);
      return round;
    });
  } catch (err: unknown) {
    if (err instanceof HttpError) throw err;
    const e = err as { statusCode?: number };
    if (e.statusCode === 404) throw new HttpError(404, "NOT_FOUND", "Round not found");
    throw new HttpError(500, "INTERNAL");
  }

  // Outside the lease AND outside the try: a failing republish must fall
  // through withErrorHandler's generic catch (http.ts:130-137) exactly as it
  // does today, not be remapped to HttpError(500, "INTERNAL") by the catch
  // above — the two produce different response bodies.
  await updateRoundsIndex(updated);
  return updated;
}
