// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * The round write TABLE and its EXECUTOR (issues #274 / #277).
 *
 * `ROUND_WRITES` is the state machine for the round writes routed here: each
 * row declares the transition's `from`/`to`, the `lease` strategy, and the
 * rate-limit `endpoint`/`tier`, so a converted handler in
 * `functions/roundsMutate.ts` is a one-liner over `applyRoundWrite`. The shared
 * pieces — id guard, caller preamble, fine scope check, limiter, storage-error
 * translation and the public-index republish — each exist exactly once below.
 *
 * Todo 1 of #277 covers the four PURE status transitions (confirm / reopen /
 * cancel / uncancel): the whole mutation is `round.status = to`. Writes that do
 * more (create, update, brief-complete, unlock) join the table in later todos;
 * `lockRound`/`completeRound` remain bespoke in `functions/roundsMutate.ts`
 * (#275 / #276).
 *
 * Ordering: `applyRoundWrite` reads `rounds/{id}.json` ONCE and resolves the
 * caller ONCE, which is why `mutationRateLimit` runs INSIDE the lease. See the
 * comment at `chargeLimiter` before moving it.
 */

import type {
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import type { CallerIdentity, Round, RoundStatus } from "@bccweb/types";
import { RoundSchema } from "@bccweb/schemas";
import { getCallerIdentity } from "./auth.js";
import { getPrivateBlobClient, withPrivateLease } from "./blob.js";
import { readJson, writePrivateJson } from "./blobJson.js";
import { HttpError } from "./http.js";
import { mutationRateLimit, type MutationRateLimitTier } from "./rateLimit.js";
import { updateRoundsIndex } from "./recompute.js";
import { assertCanManageRound, isCoord } from "./roundAuth.js";

export type RoundTransitionName = "confirm" | "reopen" | "cancel" | "uncancel";

/** The writes the executor can run; grows beyond the pure four in later todos. */
export type RoundWriteName = RoundTransitionName | "create" | "update";

interface RoundWriteSpecBase {
  /** Rate-limit bucket key suffix — `mutation:{tier}:{endpoint}`. */
  readonly endpoint: string;
  readonly tier: MutationRateLimitTier;
}

export interface TransitionWriteSpec extends RoundWriteSpecBase {
  readonly kind: "transition";
  /** Statuses the transition accepts; anything else is a 409. */
  readonly from: readonly RoundStatus[];
  readonly to: RoundStatus;
  /** Lease strategy; grows to "roundAndBrief" | "pureTrackEchoes" later. */
  readonly lease: "round";
}

/**
 * The create write. No lease and no storage-error translation: there is no
 * pre-existing round to lease or 404 on, and `mutate` persists the new record
 * itself.
 */
export interface CreateWriteSpec extends RoundWriteSpecBase {
  readonly kind: "create";
}

/**
 * The edit write (PUT /api/rounds/{id}): leases and mutates the EXISTING round
 * like a transition, but has no `from`/`to` — its own `gate` hook carries the
 * lifecycle checks (Cancelled / roster-frozen) instead of `assertFrom`.
 */
export interface EditWriteSpec extends RoundWriteSpecBase {
  readonly kind: "edit";
  readonly lease: "round";
}

/** Grows further (brief-complete / unlock) in later todos. */
export type RoundWriteSpec = TransitionWriteSpec | CreateWriteSpec | EditWriteSpec;

/** Kept exported for the importers that predate ROUND_WRITES. */
export type RoundTransitionSpec = TransitionWriteSpec;

/**
 * The four pure rows, shared by `ROUND_WRITES` (the executor's table) and
 * `ROUND_TRANSITIONS` (the legacy export). One object per row so the two can
 * never drift.
 */
const PURE_TRANSITIONS: Record<RoundTransitionName, TransitionWriteSpec> = {
  confirm: { kind: "transition", from: ["Proposed"], to: "Confirmed", lease: "round", endpoint: "confirmRound", tier: "standard" },
  reopen: { kind: "transition", from: ["BriefComplete"], to: "Confirmed", lease: "round", endpoint: "reopenBrief", tier: "standard" },
  cancel: { kind: "transition", from: ["Proposed", "Confirmed"], to: "Cancelled", lease: "round", endpoint: "cancelRound", tier: "standard" },
  uncancel: { kind: "transition", from: ["Cancelled"], to: "Proposed", lease: "round", endpoint: "uncancelRound", tier: "standard" },
};

/**
 * The write table. `apps/api/src/functions/__tests__/issue8EvidenceHarness.ts`
 * derives its rate-limit evidence rows from this table rather than re-listing
 * them, so `endpoint`/`tier` here ARE the audited call sites.
 *
 * Do NOT write `as const satisfies Record<string, RoundWriteSpec>`: `as
 * const` narrows `from` to e.g. `readonly ["Proposed"]`, and
 * `spec.from.includes(round.status)` below then fails to compile (TS2345).
 */
export const ROUND_WRITES: Record<RoundWriteName, RoundWriteSpec> = {
  ...PURE_TRANSITIONS,
  create: { kind: "create", endpoint: "createRound", tier: "standard" },
  update: {
    kind: "edit",
    lease: "round",
    endpoint: "updateRound",
    tier: "standard",
  },
};

export const ROUND_TRANSITIONS: Record<RoundTransitionName, RoundTransitionSpec> =
  PURE_TRANSITIONS;

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

/** Everything a hook needs: the request-scoped values plus the leased round. */
export interface RoundWriteContext {
  readonly req: HttpRequest;
  readonly ctx: InvocationContext;
  readonly caller: CallerIdentity;
  readonly id: string;
  readonly round: Round;
}

/**
 * Per-write behaviour that stays beside the handler. Every hook is optional;
 * the executor supplies the no-ops/defaults. Hooks that never `await` are
 * plain (non-async) functions (`@typescript-eslint/require-await` is on).
 *
 * - `scope`: 403/400-class checks needing the round or the body. Runs after
 *   `assertCanManageRound` and BEFORE the limiter. Inside the lease a
 *   non-`HttpError` throw is wrapped in `UntranslatedHookError` so translation
 *   rethrows it as-is.
 * - `gate`: 409-class checks, run after the limiter and after the transition
 *   from-gate.
 * - `preview`: honoured only when `req.query.get("dryRun") === "true"`. Runs
 *   on an UNLEASED pre-read (readRoundTranslated -> assertCanManageRound ->
 *   scope -> chargeLimiter -> assertFrom -> gate), returns the 200 body
 *   verbatim, and never persists or republishes.
 * - `mutate`: in-memory changes under the lease; returns `Extra`.
 * - `respond`: shapes the success body; defaults to the round.
 */
export interface RoundWriteHooks<Extra = undefined> {
  readonly scope?: (c: RoundWriteContext) => void | Promise<void>;
  readonly gate?: (c: RoundWriteContext) => void | Promise<void>;
  readonly preview?: (c: RoundWriteContext) => unknown;
  readonly mutate?: (c: RoundWriteContext) => Extra | Promise<Extra>;
  readonly respond?: (round: Round, extra: Extra) => unknown;
}

/**
 * The create context: there is no round id or pre-existing round, so it is the
 * request-scoped values only. Parsed body values live in the handler's own
 * closure; the hooks receive just this.
 */
export interface CreateContext {
  readonly req: HttpRequest;
  readonly ctx: InvocationContext;
  readonly caller: CallerIdentity;
}

/**
 * Hooks for the create write. Unlike the transition hooks, `scope` and
 * `mutate` are REQUIRED — every real create needs both body validation and the
 * build-and-persist step. There is no lease, so `mutate` persists the new
 * record itself and returns it; `after` is best-effort follow-up (eager brief)
 * that runs after the republish and must never fail the create.
 */
export interface CreateHooks {
  readonly scope: (c: CreateContext) => void | Promise<void>;
  readonly mutate: (c: CreateContext) => Promise<Round>;
  readonly after?: (round: Round, c: CreateContext) => void | Promise<void>;
}

/**
 * Wraps a non-`HttpError` thrown by a hook inside the lease so the translation
 * layer can unwrap and rethrow the ORIGINAL error — scope failures must not be
 * remapped to `500 INTERNAL` as if they were storage errors.
 */
class UntranslatedHookError extends Error {
  constructor(readonly cause: unknown) {
    super("untranslated hook error");
  }
}

/** The id guard: a missing route param is a 400 before any auth or blob work. */
function requireId(req: HttpRequest): string {
  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_ROUND_ID", "Missing round id");
  return id;
}

/**
 * The caller preamble: 401, then the coarse role 403. `withErrorHandler`
 * (http.ts:91-101) discards the returned `error` string, so these thrown
 * errors normalise byte-identically to `unauthorizedResponse()` /
 * `forbiddenResponse(msg)`.
 */
async function requireCoordCaller(req: HttpRequest): Promise<CallerIdentity> {
  const caller = await getCallerIdentity(req);
  if (!caller) throw new HttpError(401, "UNAUTHORIZED");
  if (!isCoord(caller.roles)) throw new HttpError(403, "FORBIDDEN");
  return caller;
}

/** Map a lease-scoped failure to the response error: 404, else generic 500. */
function translateStorageError(err: unknown): never {
  if (err instanceof HttpError) throw err;
  if (err instanceof UntranslatedHookError) throw err.cause;
  const e = err as { statusCode?: number };
  if (e.statusCode === 404) throw new HttpError(404, "NOT_FOUND", "Round not found");
  throw new HttpError(500, "INTERNAL");
}

/** Unleased read for the preview path, translated the same way a leased read is. */
async function readRoundTranslated(path: string): Promise<Round> {
  try {
    return await readJson(getPrivateBlobClient(path), RoundSchema, path);
  } catch (err: unknown) {
    translateStorageError(err);
  }
}

async function chargeLimiter(
  req: HttpRequest,
  caller: CallerIdentity,
  spec: RoundWriteSpec
): Promise<void> {
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
}

/** The 409 status gate for transitions. */
function assertFrom(spec: TransitionWriteSpec, round: Round): void {
  if (!spec.from.includes(round.status)) {
    throw new HttpError(
      409,
      "CONFLICT",
      expectedStatusDetail(spec.from, round.status)
    );
  }
}

/**
 * Republish. Outside the lease AND outside every try/catch: a failing
 * republish must fall through withErrorHandler's generic catch
 * (http.ts:130-137) exactly as it does today, not be remapped to
 * HttpError(500, "INTERNAL") by the translation — the two produce different
 * response bodies. This is the ONLY `updateRoundsIndex` call site.
 */
async function republish(round: Round): Promise<void> {
  await updateRoundsIndex(round);
}

/** Republish, then shape the 200 transition response. */
async function republishAndRespond<Extra>(
  round: Round,
  hooks: RoundWriteHooks<Extra> | undefined,
  extra: Extra
): Promise<HttpResponseInit> {
  await republish(round);
  return {
    status: 200,
    jsonBody: hooks?.respond ? hooks.respond(round, extra) : round,
  };
}

/**
 * The `round` lease strategy: requireId -> requireCoordCaller, then one of two
 * paths:
 *
 * - Preview (only when `?dryRun=true` AND the write supplies a `preview`
 *   hook): readRoundTranslated -> assertCanManageRound -> scope ->
 *   chargeLimiter -> assertFrom (transitions only) -> gate -> preview (200).
 *   Unleased, never persists, never republishes. The scope hook is NOT wrapped
 *   in `UntranslatedHookError` here: this branch never enters the lease's
 *   try/catch, so an `HttpError` already propagates as-is and anything else
 *   falls to withErrorHandler's generic catch-all — wrapping would change
 *   nothing.
 * - Otherwise: withPrivateLease{ readJson -> assertCanManageRound -> scope
 *   (untranslated) -> chargeLimiter -> [transition only: assertFrom] -> gate
 *   -> mutate -> [transition only: `round.status = spec.to`] ->
 *   writePrivateJson(round) } -> translateStorageError -> republish ->
 *   respond (200). The caller is resolved and the round read each exactly
 *   once.
 */
async function runRoundWrite<Extra>(
  req: HttpRequest,
  ctx: InvocationContext,
  spec: TransitionWriteSpec | EditWriteSpec,
  hooks: RoundWriteHooks<Extra> | undefined
): Promise<HttpResponseInit> {
  const id = requireId(req);
  const caller = await requireCoordCaller(req);

  const path = `rounds/${id}.json`;

  if (req.query.get("dryRun") === "true" && hooks?.preview) {
    const round = await readRoundTranslated(path);
    assertCanManageRound(caller, round);
    const c: RoundWriteContext = { req, ctx, caller, id, round };
    if (hooks.scope) await hooks.scope(c);
    await chargeLimiter(req, caller, spec);
    if (spec.kind === "transition") assertFrom(spec, round);
    if (hooks.gate) await hooks.gate(c);
    return { status: 200, jsonBody: await hooks.preview(c) };
  }

  let extra: Extra;
  let written: Round;

  try {
    const leased = await withPrivateLease(path, async (leaseId) => {
      // The ONLY read of the round in this request. A 404 here is impossible:
      // acquireLease (blob.ts:306-313) already ran and threw for a missing
      // blob, and the catch below maps it.
      const round = await readJson(getPrivateBlobClient(path), RoundSchema, path);

      // Fine-grained scope, 403 — step 3 of rateLimit.ts:138-164.
      assertCanManageRound(caller, round);

      const c: RoundWriteContext = { req, ctx, caller, id, round };
      if (hooks?.scope) {
        try {
          await hooks.scope(c);
        } catch (err: unknown) {
          throw err instanceof HttpError ? err : new UntranslatedHookError(err);
        }
      }
      await chargeLimiter(req, caller, spec);
      // An edit has no from/to — its gate hook carries the lifecycle checks.
      if (spec.kind === "transition") assertFrom(spec, round);
      if (hooks?.gate) await hooks.gate(c);
      const produced = hooks?.mutate
        ? await hooks.mutate(c)
        : (undefined as Extra);
      if (spec.kind === "transition") round.status = spec.to;
      await writePrivateJson(path, RoundSchema, round, leaseId);
      return { round, produced };
    });
    written = leased.round;
    extra = leased.produced;
  } catch (err: unknown) {
    translateStorageError(err);
  }

  return republishAndRespond(written, hooks, extra);
}

/**
 * The `create` write: requireCoordCaller -> scope -> chargeLimiter -> mutate
 * (which builds AND persists the new round, returning it) -> republish ->
 * after -> respond (201). No id guard, no lease and no storage-error
 * translation: there is no pre-existing round to lease or 404 on, and the
 * hook's own throws (HttpError for the expected failures, anything else
 * falling through to the generic 500) are already the correct response.
 */
async function runCreateWrite(
  req: HttpRequest,
  ctx: InvocationContext,
  spec: CreateWriteSpec,
  hooks: CreateHooks
): Promise<HttpResponseInit> {
  const caller = await requireCoordCaller(req);
  const c: CreateContext = { req, ctx, caller };
  await hooks.scope(c);
  await chargeLimiter(req, caller, spec);
  const round = await hooks.mutate(c);
  await republish(round);
  if (hooks.after) await hooks.after(round, c);
  return { status: 201, jsonBody: round };
}

/**
 * Run one table-driven round write end to end: auth, scope, rate limit,
 * status gate, leased write, and the public-index republish. Returns the
 * 200 response; every rejection is a thrown `HttpError`.
 *
 * Response codes, in the order they can fire: 400 (no id) → 401 → 403 (coarse
 * role) → 404 (no such round) → 403 (wrong club) → 429 → 409 (wrong status).
 *
 * The `"create"` overload takes the required `CreateHooks` and returns 201;
 * the general overload covers the rest of `RoundWriteName`. Overload
 * resolution on the `name` literal picks the right hook type at call sites.
 */
export function applyRoundWrite(
  req: HttpRequest,
  ctx: InvocationContext,
  name: "create",
  hooks: CreateHooks
): Promise<HttpResponseInit>;
export function applyRoundWrite<Extra = undefined>(
  req: HttpRequest,
  ctx: InvocationContext,
  name: Exclude<RoundWriteName, "create">,
  hooks?: RoundWriteHooks<Extra>
): Promise<HttpResponseInit>;
export function applyRoundWrite<Extra = undefined>(
  req: HttpRequest,
  ctx: InvocationContext,
  name: RoundWriteName,
  hooks?: RoundWriteHooks<Extra> | CreateHooks
): Promise<HttpResponseInit> {
  const spec = ROUND_WRITES[name];
  if (spec.kind === "create") {
    return runCreateWrite(req, ctx, spec, hooks as CreateHooks);
  }
  return runRoundWrite(
    req,
    ctx,
    spec,
    hooks as RoundWriteHooks<Extra> | undefined
  );
}
