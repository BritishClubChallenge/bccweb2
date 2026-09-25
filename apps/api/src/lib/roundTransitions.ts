// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * The round write TABLE and its EXECUTOR (issues #274 / #277 / #275).
 *
 * `ROUND_WRITES` is the state machine for the round writes routed here: each
 * row declares the transition's `from`/`to`, the `lease` strategy, and the
 * rate-limit `endpoint`/`tier`, so a converted handler in
 * `functions/roundsMutate.ts` is a one-liner over `applyRoundWrite`. The shared
 * pieces — id guard, caller preamble, fine scope check, limiter, storage-error
 * translation, post-commit follow-up and the public-index republish — each
 * exist exactly once below.
 *
 * Todo 1 of #277 covers the four PURE status transitions (confirm / reopen /
 * cancel / uncancel): the whole mutation is `round.status = to`. Nine writes
 * are now routed, including lock (#275) on the `roundAndBriefRollback`
 * strategy; `completeRound` remains bespoke in `functions/roundsMutate.ts`
 * (#276).
 *
 * Ordering: the read/limiter pattern is PER-STRATEGY, not executor-wide. Only
 * the plain `round` strategy reads `rounds/{id}.json` once, inside its lease,
 * and runs `mutationRateLimit` there too. `roundAndBrief`,
 * `roundAndBriefRollback` and `pureTrackEchoes` pre-read unleased (charging
 * the limiter in the preamble) and read again under their leases; `create`
 * reads no existing round and takes no lease. See the comment at
 * `chargeLimiter` before moving it.
 */

import type {
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import type { CallerIdentity, Round, RoundBrief, RoundStatus } from "@bccweb/types";
import { BriefSchema, RoundSchema } from "@bccweb/schemas";
import { getCallerIdentity } from "./auth.js";
import { getPrivateBlobClient, getPrivateBlockBlobClient, withPrivateLease, withRoundAndBriefLease } from "./blob.js";
import { readJson, writePrivateJson } from "./blobJson.js";
import { HttpError } from "./http.js";
import { mutationRateLimit, type MutationRateLimitTier } from "./rateLimit.js";
import { mutatePureTrackEchoes } from "./puretrackStatus.js";
import { updateRoundsIndex } from "./recompute.js";
import { assertCanManageRound, isCoord } from "./roundAuth.js";
import { getTelemetryClient } from "./telemetry.js";

export type RoundTransitionName = "confirm" | "reopen" | "cancel" | "uncancel";

/** The writes the executor can run (`complete` joins in #276). */
export type RoundWriteName =
  | RoundTransitionName
  | "create"
  | "update"
  | "briefComplete"
  | "unlock"
  | "lock";

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
  /** Lease strategy. */
  readonly lease: "round" | "roundAndBrief" | "pureTrackEchoes";
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

/**
 * A transition committed under BOTH leases with a compensating brief rollback
 * (lock). `persistFailure` is the row's declared response to ANY non-HttpError
 * raised inside the lease; it replaces translateStorageError for this strategy.
 */
export interface RollbackTransitionWriteSpec extends RoundWriteSpecBase {
  readonly kind: "transition";
  readonly from: readonly RoundStatus[];
  readonly to: RoundStatus;
  readonly lease: "roundAndBriefRollback";
  readonly persistFailure: { readonly code: string; readonly detail: string };
}

/** The full write-spec union. */
export type RoundWriteSpec =
  | TransitionWriteSpec
  | RollbackTransitionWriteSpec
  | CreateWriteSpec
  | EditWriteSpec;

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
  briefComplete: {
    kind: "transition",
    from: ["Confirmed"],
    to: "BriefComplete",
    lease: "roundAndBrief",
    endpoint: "briefCompleteRound",
    tier: "standard",
  },
  unlock: {
    kind: "transition",
    from: ["Locked"],
    to: "Confirmed",
    lease: "pureTrackEchoes",
    endpoint: "unlockRound",
    tier: "standard",
  },
  lock: {
    kind: "transition",
    from: ["BriefComplete"],
    to: "Locked",
    lease: "roundAndBriefRollback",
    endpoint: "lockRound",
    tier: "heavy",
    persistFailure: {
      code: "BRIEF_PERSIST_FAILED",
      detail:
        "Failed to persist the brief while locking — the round remains BriefComplete; reopen and re-complete before retrying the lock",
    },
  },
};

export const ROUND_TRANSITIONS: Record<RoundTransitionName, RoundTransitionSpec> =
  PURE_TRANSITIONS;

/**
 * The exact 409 detail. Its only call site is `assertFrom`, shared by every
 * transition write's preview and real path, so the two cannot drift. Stays
 * exported because `briefCompleteDryRun.test.ts` imports it directly for test
 * assertions.
 */
export function expectedStatusDetail(
  from: readonly RoundStatus[],
  actual: RoundStatus
): string {
  return `Expected status ${from.join(" or ")}, got ${actual}`;
}

/**
 * Everything a hook needs: the request-scoped values plus the round. Whether
 * `round` is LEASED depends on the hook and strategy: preview and
 * strategy-preamble hooks (`scope`/`gate` on `roundAndBrief` and
 * `pureTrackEchoes`, and every preview-path hook) receive the UNLEASED
 * pre-read; `mutate` and the `round` strategy's in-lease hooks receive the
 * fresh leased read. Hooks must not rely on the lease being held unless they
 * run under one.
 */
export interface RoundWriteContext {
  readonly req: HttpRequest;
  readonly ctx: InvocationContext;
  readonly caller: CallerIdentity;
  readonly id: string;
  readonly round: Round;
  /**
   * The FRESH, leased brief read — populated ONLY by the `roundAndBrief`,
   * `roundAndBriefRollback` and `pureTrackEchoes` lease strategies.
   * `roundAndBrief` and `roundAndBriefRollback` set it solely on the `mutate`
   * context; `pureTrackEchoes` builds one context for its whole in-callback
   * chain, so its `gate` sees the leased brief too. Always `undefined` for
   * `round`-lease writes and on every preview path (the preview works on the
   * handler's own unleased pre-read instead).
   */
  readonly brief?: RoundBrief;
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
 *   from-gate. For `roundAndBrief`/`roundAndBriefRollback` it runs pre-lease on
 *   the unleased pre-read and may stash per-invocation data for later hooks:
 *   brief-complete stashes the pre-read brief, and lock stashes the pilot
 *   Snapshots and the lock candidate. Checks that need the LEASED brief throw
 *   from `mutate` before it changes anything: brief-complete's
 *   `ROSTER_INCOMPLETE`, and lock's `BRIEF_HASH_MISMATCH`,
 *   `SIGNATURE_LEDGER_UNAVAILABLE` and `SIGNATURES_INCOMPLETE`.
 * - `preview`: honoured only when `req.query.get("dryRun") === "true"`. Runs
 *   on an UNLEASED pre-read (readRoundTranslated -> assertCanManageRound ->
 *   scope -> chargeLimiter -> assertFrom -> gate), returns the 200 body
 *   verbatim, and never persists or republishes.
 * - `mutate`: in-memory changes under the lease; returns `Extra`.
 * - `afterCommit`: runs after the lease is released and BEFORE the republish,
 *   on the committed round — the object that is then republished and returned,
 *   so the hook may refresh fields on it. The executor contains any throw via
 *   `ctx.error`, so it can never fail the write or skip the republish. It never
 *   runs for rejections or previews. It differs from create's `after`, which
 *   runs after the republish and is not contained.
 * - `respond`: shapes the success body; defaults to the round.
 */
export interface RoundWriteHooks<Extra = undefined> {
  readonly scope?: (c: RoundWriteContext) => void | Promise<void>;
  readonly gate?: (c: RoundWriteContext) => void | Promise<void>;
  readonly preview?: (c: RoundWriteContext) => unknown;
  readonly mutate?: (c: RoundWriteContext) => Extra | Promise<Extra>;
  readonly afterCommit?: (c: RoundWriteContext) => void | Promise<void>;
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
  // DELIBERATELY INSIDE THE LEASE in the `round` strategy (its ONLY call
  // site there) — do not hoist this into the handler. The other strategies
  // call it from their UNLEASED preambles instead (see runRoundAndBriefWrite /
  // runRoundAndBriefRollbackWrite / runPureTrackEchoesWrite): they read the
  // round before the lease, so the scope check and the limiter both resolve
  // pre-lease there.
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
function assertFrom(
  spec: TransitionWriteSpec | RollbackTransitionWriteSpec,
  round: Round
): void {
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

/**
 * The shared post-commit tail: afterCommit (contained) -> republish (outside
 * every try/catch) -> respond (200). The try/catch wraps ONLY the `afterCommit`
 * call so a post-commit throw can never fail the write or skip the republish;
 * `republish` itself stays outside every try/catch (see `republish` above).
 */
async function republishAndRespond<Extra>(
  committed: RoundWriteContext,
  hooks: RoundWriteHooks<Extra> | undefined,
  extra: Extra
): Promise<HttpResponseInit> {
  if (hooks?.afterCommit) {
    try {
      await hooks.afterCommit(committed);
    } catch (err: unknown) {
      committed.ctx.error(
        `[round ${committed.id}] post-commit work failed after the write committed:`,
        err
      );
    }
  }
  await republish(committed.round);
  return {
    status: 200,
    jsonBody: hooks?.respond ? hooks.respond(committed.round, extra) : committed.round,
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

  return republishAndRespond({ req, ctx, caller, id, round: written }, hooks, extra);
}

/**
 * The `roundAndBrief` lease strategy (brief-complete): requireId ->
 * requireCoordCaller -> readRoundTranslated -> assertCanManageRound -> scope ->
 * chargeLimiter -> assertFrom -> gate -> [preview returns here] ->
 * withRoundAndBriefLease{ readJson(round) -> assertFrom -> readJson(brief,
 * BriefSchema) -> mutate({round, brief}) -> `round.status = spec.to` ->
 * writePrivateJson(brief, briefLeaseId) -> writePrivateJson(round,
 * roundLeaseId) } -> translateStorageError -> republish -> respond (200).
 *
 * The unleased pre-read is what the preview and the real path share; the real
 * path then re-reads the round INSIDE the lease and re-runs `assertFrom` —
 * check-then-act, since the status may have moved between the pre-read and
 * lease acquisition. `assertCanManageRound`, `scope`, the limiter and `gate`
 * run ONCE, in the preamble: club membership is not the race the lease
 * protects against.
 *
 * R8 write order (replaces `completeBriefTransaction`, roundsMutate.ts): the
 * BRIEF is written BEFORE the round so a crashed second write never leaves a
 * BriefComplete round pointing at an unfrozen brief. Setting `round.status =
 * spec.to` AFTER `mutate` is safe because `invalidatePriorSignToFlyFlags`
 * (lib/signTofly/invalidate.ts) never reads `round.status` — it keys purely on
 * the brief version and slot fields.
 *
 * The `mutate` hook receives a context whose `brief` field is the FRESH leased
 * brief read (a different object from the handler's pre-read — state may have
 * moved under it), so the freeze/invalidation acts on what is actually
 * persisted.
 */
async function runRoundAndBriefWrite<Extra>(
  req: HttpRequest,
  ctx: InvocationContext,
  spec: TransitionWriteSpec,
  hooks: RoundWriteHooks<Extra> | undefined
): Promise<HttpResponseInit> {
  const id = requireId(req);
  const caller = await requireCoordCaller(req);

  const path = `rounds/${id}.json`;

  // The shared unleased preamble: pre-read, fine scope, limiter, status gate,
  // then the write's own gate (brief-complete: the brief must already exist).
  // No try/catch here — readRoundTranslated self-contains its translation and
  // hook HttpErrors propagate straight to withErrorHandler.
  const preRound = await readRoundTranslated(path);
  assertCanManageRound(caller, preRound);
  const preContext: RoundWriteContext = { req, ctx, caller, id, round: preRound };
  if (hooks?.scope) await hooks.scope(preContext);
  await chargeLimiter(req, caller, spec);
  assertFrom(spec, preRound);
  if (hooks?.gate) await hooks.gate(preContext);

  if (req.query.get("dryRun") === "true" && hooks?.preview) {
    return { status: 200, jsonBody: await hooks.preview(preContext) };
  }

  let extra: Extra;
  let written: Round;

  try {
    const leased = await withRoundAndBriefLease(id, async (roundLeaseId, briefLeaseId) => {
      const round = await readJson(getPrivateBlobClient(path), RoundSchema, path);
      assertFrom(spec, round);
      const briefPath = `round-briefs/${id}.json`;
      const brief = await readJson(getPrivateBlobClient(briefPath), BriefSchema, briefPath);
      const c: RoundWriteContext = { req, ctx, caller, id, round, brief };
      const produced = hooks?.mutate
        ? await hooks.mutate(c)
        : (undefined as Extra);
      round.status = spec.to;
      await writePrivateJson(briefPath, BriefSchema, brief, briefLeaseId);
      await writePrivateJson(path, RoundSchema, round, roundLeaseId);
      return { round, produced };
    });
    written = leased.round;
    extra = leased.produced;
  } catch (err: unknown) {
    translateStorageError(err);
  }

  return republishAndRespond({ req, ctx, caller, id, round: written }, hooks, extra);
}

/**
 * The `roundAndBriefRollback` lease strategy (lock): requireId ->
 * requireCoordCaller -> readRoundTranslated -> assertCanManageRound -> scope ->
 * chargeLimiter -> assertFrom -> gate -> withRoundAndBriefLease{ readJson(round)
 * -> assertFrom -> readJson(brief, BriefSchema) -> capture the brief's raw bytes
 * -> mutate({round, brief}) -> `round.status = spec.to` -> writePrivateJson(brief,
 * briefLeaseId) -> writePrivateJson(round, roundLeaseId); if the round write
 * fails, restore the raw brief bytes under the brief lease (a failed restore emits
 * `puretrack.crossBlobReconcileRequired` with `operation` = the row key) and
 * rethrow } -> non-HttpError -> `persistFailure` -> afterCommit -> republish ->
 * respond (200). No preview path.
 *
 * (a) The lease block deliberately does NOT use `translateStorageError`. Every
 * non-`HttpError` becomes `spec.persistFailure`. That includes:
 *   - lease acquisition failures, such as a 404 for a round or brief that
 *     vanished, or exhausted 409/412 retries;
 *   - read failures, including `BlobShapeError`;
 *   - write failures;
 *   - a failed rollback.
 *
 * `HttpError`s thrown by hooks pass through unchanged.
 *
 * (b) `withPrivateLeaseRetry` may re-run the callback when a storage 409/412
 * escapes it (blob.ts:286-304). That is why the committed context is built from
 * the callback's return value, and why `mutate` must be re-entrant: it only
 * reads what `gate` stashed. In-lease `HttpError`s carry `status`, not
 * `statusCode` (http.ts:19-32), so they are never retried.
 *
 * (c) The brief-then-round order, the byte-exact rollback and the reconcile
 * event were moved from `lockRound` (roundsMutate.ts). A failed brief write
 * must leave the round BriefComplete, so the round write never runs unless the
 * brief write succeeded; a failed round write restores the brief's original
 * bytes so the two blobs never diverge. `operation` is the row's key.
 *
 * (d) The pre-read exists so that the `gate` hook's pilot-Snapshot fan-out runs
 * outside the lease.
 */
async function runRoundAndBriefRollbackWrite<Extra>(
  req: HttpRequest,
  ctx: InvocationContext,
  name: RoundWriteName,
  spec: RollbackTransitionWriteSpec,
  hooks: RoundWriteHooks<Extra> | undefined
): Promise<HttpResponseInit> {
  const id = requireId(req);
  const caller = await requireCoordCaller(req);

  const path = `rounds/${id}.json`;

  const preRound = await readRoundTranslated(path);
  assertCanManageRound(caller, preRound);
  const preContext: RoundWriteContext = { req, ctx, caller, id, round: preRound };
  if (hooks?.scope) await hooks.scope(preContext);
  await chargeLimiter(req, caller, spec);
  assertFrom(spec, preRound);
  if (hooks?.gate) await hooks.gate(preContext);

  let extra: Extra;
  let written: Round;

  try {
    const leased = await withRoundAndBriefLease(id, async (roundLeaseId, briefLeaseId) => {
      const round = await readJson(getPrivateBlobClient(path), RoundSchema, path);
      assertFrom(spec, round);
      const briefPath = `round-briefs/${id}.json`;
      const brief = await readJson(getPrivateBlobClient(briefPath), BriefSchema, briefPath);
      const briefClient = getPrivateBlockBlobClient(briefPath);
      const originalBriefBytes = await briefClient.downloadToBuffer();
      const c: RoundWriteContext = { req, ctx, caller, id, round, brief };
      const produced = hooks?.mutate ? await hooks.mutate(c) : (undefined as Extra);
      round.status = spec.to;
      await writePrivateJson(briefPath, BriefSchema, brief, briefLeaseId);
      try {
        await writePrivateJson(path, RoundSchema, round, roundLeaseId);
      } catch (roundWriteError: unknown) {
        await briefClient
          .upload(originalBriefBytes, originalBriefBytes.length, {
            blobHTTPHeaders: { blobContentType: "application/json" },
            conditions: { leaseId: briefLeaseId },
          })
          .catch((rollbackError: unknown) => {
            getTelemetryClient()?.trackEvent({
              name: "puretrack.crossBlobReconcileRequired",
              properties: {
                roundId: id,
                operation: name,
                roundWriteError: roundWriteError instanceof Error ? roundWriteError.name : "unknown",
                rollbackError: rollbackError instanceof Error ? rollbackError.name : "unknown",
              },
            });
          });
        throw roundWriteError;
      }
      return { round, produced };
    });
    written = leased.round;
    extra = leased.produced;
  } catch (err: unknown) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(500, spec.persistFailure.code, spec.persistFailure.detail);
  }

  return republishAndRespond({ req, ctx, caller, id, round: written }, hooks, extra);
}

/**
 * The `pureTrackEchoes` lease strategy (unlock): requireId ->
 * requireCoordCaller -> readRoundTranslated -> assertCanManageRound -> scope ->
 * chargeLimiter -> mutatePureTrackEchoes(id, cb{ [L] assertFrom -> gate ->
 * mutate({round, brief}) -> `round.status = spec.to` -> capture -> return
 * true }) -> republish -> respond (200).
 *
 * Unlike the other strategies this one DELEGATES the whole
 * lease/read/clone/write/rollback lifecycle to `mutatePureTrackEchoes`
 * (lib/puretrackStatus.ts), which owns its own dual lease, lazy
 * placeholder-brief creation, structuredClone, brief-then-round persist and
 * same-blob rollback. Two deliberate differences from `roundAndBrief`:
 *
 * - The call sits OUTSIDE translateStorageError: a plain (non-HttpError)
 *   failure from the delegated call — e.g. an injected writePrivateJson
 *   failure — must reach withErrorHandler's generic catch-all UNCHANGED (the
 *   lowercase "Internal server error" body), exactly as the hand-rolled
 *   handler behaved (roundsMutate.ts, pre-#277).
 * - There is NO pre-lease status check: the ONLY `assertFrom` runs inside the
 *   callback, on the leased clone. The unleased pre-read exists solely to
 *   feed `assertCanManageRound` — it deliberately never gates status, so a
 *   status change between pre-read and lease is caught by the in-lease check,
 *   and `ensureBriefExists` never gets to placeholder-create a brief for a
 *   round that does not exist (the pre-read 404s first).
 */
async function runPureTrackEchoesWrite<Extra>(
  req: HttpRequest,
  ctx: InvocationContext,
  spec: TransitionWriteSpec,
  hooks: RoundWriteHooks<Extra> | undefined
): Promise<HttpResponseInit> {
  const id = requireId(req);
  const caller = await requireCoordCaller(req);

  const path = `rounds/${id}.json`;

  // The shared unleased preamble: pre-read (scope input ONLY — never a status
  // gate), fine scope, limiter. No try/catch — readRoundTranslated
  // self-contains its translation and hook HttpErrors propagate straight to
  // withErrorHandler.
  const preRound = await readRoundTranslated(path);
  assertCanManageRound(caller, preRound);
  const preContext: RoundWriteContext = { req, ctx, caller, id, round: preRound };
  if (hooks?.scope) await hooks.scope(preContext);
  await chargeLimiter(req, caller, spec);

  let capturedRound: Round | undefined;
  // Definite-assignment: TS cannot prove the callback runs, but the guard
  // below throws unless capturedRound was set — and both are assigned together.
  let capturedExtra!: Extra;

  await mutatePureTrackEchoes(id, async ({ round, brief }) => {
    assertFrom(spec, round);
    const c: RoundWriteContext = { req, ctx, caller, id, round, brief };
    if (hooks?.gate) await hooks.gate(c);
    const produced = hooks?.mutate
      ? await hooks.mutate(c)
      : (undefined as Extra);
    round.status = spec.to;
    capturedRound = round;
    capturedExtra = produced;
    return true;
  });

  // Defensive guard, preserved from the pre-#277 handler: every actual code
  // path either throws or captures, but an uncaptured round is a 500, never a
  // silently empty 200.
  if (capturedRound === undefined) throw new HttpError(500, "INTERNAL");
  return republishAndRespond({ req, ctx, caller, id, round: capturedRound }, hooks, capturedExtra);
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
  if (spec.kind === "transition" && spec.lease === "roundAndBrief") {
    return runRoundAndBriefWrite(
      req,
      ctx,
      spec,
      hooks as RoundWriteHooks<Extra> | undefined
    );
  }
  if (spec.kind === "transition" && spec.lease === "roundAndBriefRollback") {
    return runRoundAndBriefRollbackWrite(req, ctx, name, spec, hooks as RoundWriteHooks<Extra> | undefined);
  }
  if (spec.kind === "transition" && spec.lease === "pureTrackEchoes") {
    return runPureTrackEchoesWrite(
      req,
      ctx,
      spec,
      hooks as RoundWriteHooks<Extra> | undefined
    );
  }
  return runRoundWrite(
    req,
    ctx,
    spec,
    hooks as RoundWriteHooks<Extra> | undefined
  );
}
