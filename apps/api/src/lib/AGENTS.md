# apps/api/src/lib — API helpers

Usage contracts for the shared helpers. [`apps/api/AGENTS.md`](../../AGENTS.md) lists
these by name and owns the module map/auth/env; this file is the **cheat sheet** so you
don't re-read the source.

## queue.ts — producers + job schemas

- `enqueueBriefPdf`/`enqueueSignToFlyReflect`/`enqueuePureTrackGroupJob` and
  `igcValidationJob.ts`'s `enqueueIgcValidation` obtain named runtime-account clients
  through `storageClients.ts`. Local/Azurite mode uses `AzureWebJobsStorage` (the only
  setting with a `QueueEndpoint` locally); identity mode uses
  `RUNTIME_STORAGE_ACCOUNT_NAME` plus `STORAGE_UMI_CLIENT_ID`. The Functions host's queue
  triggers separately resolve `AzureWebJobsStorage__accountName`, `__credential`, and
  `__clientId`. **Never** switch a producer to `BLOB_CONNECTION_STRING` — that's blob-only
  and would silently break queueing.
- `BriefPdfJobSchema`, `SignToFlyReflectJobSchema`, `PureTrackGroupJobSchema` are
  `z.object({...}).strict()` — any extra key is rejected at serialisation time so PII can
  never enter a queue message. `RescoreJobMessageSchema` (same pattern) lives in
  `rescoreJob.ts`; `IgcValidationJobSchema` lives in
  `packages/schemas/src/igcValidationJob.ts`.
- `igcValidationJob.ts` also owns create-only durable validation-attempt results and the
  global leased guard that serializes and paces FAI calls.
- Full flow-by-flow detail (brief PDF / sign reflect / rescore / PureTrack / IGC
  validation, CAS/attempt semantics, poison behavior) is in
  [docs/architecture/storage-and-queues.md](../../../../docs/architecture/storage-and-queues.md).

## blob.ts — clients + leases

- `storageClients.ts` is the only application SDK-construction/authentication seam:
  `BLOB_CONNECTION_STRING` preserves local/Azurite behavior; deployed Azure uses the data-account
  pair `BLOB_STORAGE_ACCOUNT_NAME` + `STORAGE_UMI_CLIENT_ID` selects the Function UMI.
  This workload identity is distinct from the staging OIDC operator identity used by
  scripts and deployment automation. Direct container helpers call
  `getBlobServiceClient().getContainerClient(name)` so public/private names stay local to
  their existing owners.
- `getBlobClient/getBlockBlobClient(path)` (public), `getPrivateBlobClient/...` (private).
  All four accessors call `assertSafeBlobPath(path)` first — the single choke point for
  every USER-INPUT-DERIVED path. Rules: non-empty path; every `/`-segment matches
  `^[A-Za-z0-9._-]+$`; rejected outright: backslash, control chars (U+0000–U+001F,
  U+007F), empty/`.`/`..` segments. Throws `HttpError` `400 INVALID_BLOB_PATH`.
  The eight documented raw-container seams — `puretrack.ts`, `puretrackGroups.ts`,
  `clubs.ts`, `seasonClubs.ts`, `signTofly/wording.ts`, `signTofly/ledger.ts` (prefix
  listing), `auditLog.ts`, `admin.ts` (config) — intentionally bypass it because none
  interpolates user input into a path.
- `readBlob(client)` raw JSON parse (missing → Azure 404). `writeBlob(path,data,leaseId?,{ifNoneMatch?})`.
- `writePrivateBlob(path,data,leaseId?,{ifNoneMatch?})` — `ifNoneMatch:"*"` = create-only.
- `ensureJsonIndexBlob` / `ensurePrivateJsonIndexBlob(path,seed)` — create-only seed (409/412 = no-op).
- `withLease` / `withPrivateLease(path, fn)` — 30s lease, passes `leaseId`, best-effort release.
- `...LeaseRetry(...)` retries 409/412 conflicts; `...LeaseRenewing(...)` for long work →
  throws `LeaseRenewalFailedError` if renew fails.
- `withRoundAndBriefLease(roundId, fn)` — the cross-blob primitive: acquires the ROUND lease
  (`rounds/{id}.json`) THEN the BRIEF lease (`round-briefs/{id}.json`) in that FIXED order
  (deadlock-free), runs `fn(roundLeaseId, briefLeaseId)`, releases brief-then-round. Both are
  30s leases that retry on 409/412 contention so concurrent cross-blob edits serialize. The
  brief blob must already exist — create-or-skip it (`writePrivateBlob(..., {ifNoneMatch:"*"})`)
  first. Route every brief edit / brief-complete / signature cross-blob RMW through this.
  The round-write executor (`roundTransitions.ts`) reaches these primitives only through
  `roundRecord.ts`, never directly.
- `resetBlobSingletons()` / `resetQueueSingletons()` — **test-only**; clear their local
  caches and the shared `storageClients.ts` caches so environment is re-read.
- Gotcha: release failure is telemetry-only; the fn's result/error wins.

## blobJson.ts — schema-validated JSON (the real read/write helpers live HERE, not blob.ts)

- `readJson(client,schema,path)` — validates vs zod, throws `BlobShapeError`, emits
  `blob.healed` when raw JSON healed on read.
- `writeJson` / `writePrivateJson(path,schema,data,leaseId?,opts?)` — validate-first;
  `observe` logs bad shapes, `enforce` strips/rejects before delegating to `writeBlob`.
- Prefer these helpers for schema-backed domain JSON. Raw operational/control records and
  deliberate lease/index operations must document their exception at the call site.

## http.ts

- `HttpError(status,code,detail?,headers?)`, `BlobShapeError(path,schemaName,issues)`.
- `withErrorHandler(handler)` — `HttpError`→`{error,code,requestId,detail?}`,
  `BlobShapeError`→`500 DATA_SHAPE_INVALID`, else generic 500. Any returned `status>=400` is normalized too.

## auth.ts / authHelpers.ts

- `getCallerIdentity(req)` — validates access JWT, resolves/creates user → `CallerIdentity | null`
  (bad/missing token = `null`; caller chooses 401 vs 403).
- `unauthorizedResponse()` (401), `forbiddenResponse()` (403).
- `signAccessToken` (1h), `signRefreshToken` (30d), `verifyRefreshToken`.
- `hashPassword`/`verifyPassword` (bcrypt; `TEST_BCRYPT_COST` honored only in test env).
- `generateShortLivedToken` / `consumeShortLivedToken` — one-shot via ETag CAS →
  `TokenNotFound/Expired/AlreadyConsumed` errors. `lookupUserByEmail`.
- `getAppUrl()` supplies the public origin for verification/reset email links with precedence
  `APP_URL` → `WEBSITE_HOSTNAME` (prefixed with `https://`) →
  `http://localhost:5173`; local development therefore does not require `APP_URL`.

## recompute.ts

- `updateRoundsIndex(round)` — upsert `rounds.json` summary (leased RMW).
- `recomputeSeason(year)` — dedupes concurrent recomputes; rebuilds `seasons/{year}.json`,
  `results/{year}.json`, `rounds.json`. Uses `.lock` + `.recompute.lock`; may leave `.tmp` for forensics.

## telemetry.ts / telemetryRedactor.ts

- `setup()`: one-time App Insights init, **call early** (processors attach only here via `setAzureMonitorOptions`), no-op without env. `getTelemetryClient()`, `resetForTests()`.
- `PII_FIELDS` (must match `scripts/lib/pii.mjs`), `redactObject(obj,fields?)`.
- `PiiRedactingSpanProcessor`: drops successful `Functions.health` spans (retains failed ones) and redacts PII from request/dependency span attributes (PII_FIELDS + `OTEL_PII_SPAN_ATTRS`).
- `PiiRedactingLogRecordProcessor`: redacts PII from trackEvent/trackTrace log record attributes.

## roundAuth.ts — who may act on THIS round (BOLA / IDOR)

- `isCoord(roles)` — coarse "is a RoundsCoord or Admin at all" gate; step 2 of the
  `rateLimit.ts:138-164` ordering contract, so it runs BEFORE the round is read and
  therefore CANNOT scope a coord to a club. Always pair it with an assert below.
- `canManageRound(caller, round)` / `assertCanManageRound(...)` — MUTATE the round: an
  Admin, or a RoundsCoord whose `clubId` matches `round.organisingClub.id`. The assert
  throws `403 FORBIDDEN`.
- `canRegisterClubForRound(caller, round, clubId)` / `assertCanRegisterForClub(...)` —
  enter teams/pilots for ONE club: a manager, or any RoundsCoord acting on their OWN club
  (so a visiting club's coord can enter their own teams without controlling the round).
- `canAccountForSlot(caller, round, team, slot)` / `assertCanAccountForSlot(...)` — mark a
  slot accounted-for: a manager (any slot), the team captain (any slot in their team), or
  the pilot themselves (their own slot only).
- `isRoundParticipant(caller, round)` — the caller's `pilotId` occupies a `Filled` slot.
- `canViewRoundDetail(caller, round)` — READ private round detail (incl. brief): manager
  OR participant.
- `redactRoundSnapshots(round)` — copy of the round with every pilot snapshot reduced to
  `wingClass` + `pilotRating`; strips the lock-time medical/emergency/contact PII for
  callers who may read the round but must not see it.

## roundGates.ts — round-lifecycle 409 helpers

- `findUnaccountedSlots(round)` — Filled slots with `accountedFor !== true`; backs
  `completeRound`'s `409 PILOTS_NOT_ACCOUNTED_FOR` gate. Counts null-`pilotId` and
  `noScore` slots (a physical-presence check, unlike `SignToFlyResolution.unsignedSlots`).
- `formatSlotRefs(slots)` — renders `Team #place (pilotId)` joined by `"; "`;
  shared by that gate and `lockRound`'s `SIGNATURES_INCOMPLETE` detail so both
  read identically. `SignToFlyResolution.unsignedSlots` lives in `signTofly/resolution.ts`
  (it needs the brief + ledger); only the round-only scan and the formatter live here.

## roundRecord.ts — the round record store

- Purpose: the expand step of #282. The record is the single owner of the round and brief
  blob paths (`rounds/{id}.json`, `round-briefs/{id}.json`), of which blob lease primitive
  each operation takes, of the lock brief rollback and its telemetry, and of per-operation
  missing-round semantics. The round-write executor (`roundTransitions.ts`) is its first
  and only consumer. Every other caller keeps using the old primitives (`withPrivateLease`,
  `withRoundAndBriefLease`, `readJson`, ...) directly until #283 migrates them.
- The six operations:
  - `readRound(id): Promise<Round>`
  - `mutateRound(id, step: (round) => Promise<T>): Promise<RoundMutation<T>>`
  - `mutateRoundRenewing(id, step: (round) => Promise<T>): Promise<RoundMutation<T>>`
  - `mutateRoundWithBrief(id, steps: RoundAndBriefSteps<T>): Promise<RoundMutation<T>>`
  - `mutateRoundWithBriefOrRestore(id, operation: string, steps: RoundAndBriefSteps<T>): Promise<RoundMutation<T>>`
  - `mutateRoundWithPureTrackEchoes(id, step: ({ round, brief }) => Promise<T>): Promise<RoundMutation<T>>`

  | op | lease primitive | missing round | non-404 error |
  | --- | --- | --- | --- |
  | `readRound` | none | 404 `NOT_FOUND` `HttpError` | propagated unchanged |
  | `mutateRound` | plain private lease (`withPrivateLease`) | 404 `NOT_FOUND` `HttpError` | propagated unchanged |
  | `mutateRoundRenewing` | renewing private lease (`withPrivateLeaseRenewing`) | 404 `NOT_FOUND` `HttpError` | propagated unchanged |
  | `mutateRoundWithBrief` | round+brief lease (`withRoundAndBriefLease`) | 404 `NOT_FOUND` `HttpError` | propagated unchanged |
  | `mutateRoundWithBriefOrRestore` | round+brief lease + brief restore | propagated unchanged (lock maps it) | propagated unchanged |
  | `mutateRoundWithPureTrackEchoes` | via `mutatePureTrackEchoes` | propagated unchanged | propagated unchanged |

  The 404 mapping is duck-typed on the thrown object's own status code (a storage 404 from
  lease acquisition or the read, or a 404-status error thrown from the step). The two
  non-translating operations exist for byte-compatibility with lock's persist-failure answer
  and unlock's generic-catch answer; #283/#286 must preserve that.
- Every mutation returns `{ round, result }` (`RoundMutation<T>`): `round` is the same object
  instance the step received and the record wrote, `result` is the step's return value.
  The PureTrack-echoes operation answers a defensive `500 INTERNAL` if the delegated
  primitive returns without committing.
- The cross-blob operations take a two-stage `RoundAndBriefSteps<T>`: `beforeBrief(round)`
  runs on the leased round BEFORE the brief is read (the executor's status re-check), then
  `mutate({ round, brief })` changes both documents in memory. The record then writes the
  BRIEF before the round, so a crash never leaves the round pointing at an unfrozen brief.
- `mutateRoundWithBriefOrRestore` captures the brief's raw bytes before the step. If the
  round write fails after the brief write, it restores those bytes byte-exact under the
  brief lease; a failed restore emits `puretrack.crossBlobReconcileRequired` with `roundId`,
  `operation` (the caller's row key), `roundWriteError` and `rollbackError`, then the
  original round-write error is rethrown.
- Each operation reads the round exactly once and never adds an existence pre-check: a
  missing blob surfaces from the lease acquisition or that one read.
- Argument shapes existing spies rely on: `withRoundAndBriefLease` gets the bare round id;
  `withPrivateLease` and `withPrivateLeaseRenewing` get the full `rounds/{id}.json` path, and
  the renewing call never passes options; `readJson` gets the path as its 3rd argument.
- `roundRecord.ts` must not import from `roundTransitions.ts` (or `../functions/`,
  `./roundAuth.js`), including type-only imports; `operation` is typed `string`.
- Pins in `functions/__tests__/roundWriteContract.test.ts`: n1 says `roundRecord.ts`
  contains exactly one each of `"Round not found"`, `"puretrack.crossBlobReconcileRequired"`,
  `withPrivateLeaseRenewing(`, `withPrivateLease(`, `mutatePureTrackEchoes(` and the
  `rounds/` and `round-briefs/` path templates; n2 says it never contains the substring
  naming the executor module. k4 (one reconcile event) and m4 (one renewing-lease call)
  were re-homed from the executor onto `roundRecord.ts`.

## roundTransitions.ts — the round write table and executor

- `ROUND_WRITES: Record<RoundWriteName, RoundWriteSpec>` is the SOURCE OF TRUTH for the
  ten round writes (every round write). Every row carries the rate-limit `endpoint` + `tier`
  (`__tests__/issue8EvidenceHarness.ts` derives its evidence rows from the table, so these
  ARE the audited call sites) and a `kind`:
  - `transition` (`from[]`, `to`, `lease`): `confirm`/`reopen`/`cancel`/`uncancel` and
    `briefComplete` (`lease:"roundAndBrief"`) and `unlock` (`lease:"pureTrackEchoes"`)
    and `lock` (`lease:"roundAndBriefRollback"`, whose row also declares `persistFailure`)
    and `complete` (`lease:"roundRenewing"`); the four pure rows use `lease:"round"`.
  - `edit` (`lease:"round"`, no `from`/`to`): `update`; its `gate` hook carries the
    lifecycle checks instead of `assertFrom`.
  - `create` (no lease): `create`.
  `ROUND_TRANSITIONS` survives as a legacy export of the same four pure row objects (one
  shared `PURE_TRANSITIONS` object, so they can't drift). Don't use `as const satisfies` on the table:
  it narrows `from` and breaks `spec.from.includes(...)` (TS2345).
- `applyRoundWrite(req, ctx, name, hooks?)` dispatches on the row: `kind:"create"` →
  `runCreateWrite`; transition + `roundAndBrief` → `runRoundAndBriefWrite`; transition +
  `roundAndBriefRollback` → `runRoundAndBriefRollbackWrite`; transition + `roundRenewing` →
  `runRoundRenewingWrite`; transition +
  `pureTrackEchoes` → `runPureTrackEchoesWrite`; everything else (plain `round` lease) →
  `runRoundWrite`. The `"create"` overload takes required `CreateHooks` and returns 201;
  the rest return 200. Every rejection is a thrown `HttpError`, so handlers are one-liners.
  Codes fire in the order 400 (no id) → 401 → 403 (coarse role) → 404 → 403 (wrong club)
  → 429 → 409. Lock can also answer `500 BRIEF_PERSIST_FAILED` (its row's
  `persistFailure`) for any non-`HttpError` inside its lease. Complete's in-lease `gate` can answer
  `409 PILOTS_NOT_ACCOUNTED_FOR` after the status gate.
- Hook slots (`RoundWriteHooks<Extra>`, all optional):
  - `scope`: 403/400-class checks needing the round or body. Runs after
    `assertCanManageRound`, BEFORE the limiter. Only inside `runRoundWrite`'s leased path is
    a non-`HttpError` throw wrapped in `UntranslatedHookError`, so `translateStorageError`
    rethrows the original instead of remapping it to `500 INTERNAL`.
  - `gate`: 409-class checks, after the limiter and after `assertFrom`. For `roundAndBrief`
    and `roundAndBriefRollback` it runs pre-lease on the unleased pre-read and may stash
    per-invocation data for later hooks (brief-complete: the pre-read brief; lock: the
    pilot Snapshots and the lock candidate). Checks that need the LEASED brief throw from
    `mutate` before it changes anything (brief-complete's `ROSTER_INCOMPLETE`; lock's
    `BRIEF_HASH_MISMATCH`, `SIGNATURE_LEDGER_UNAVAILABLE`, `SIGNATURES_INCOMPLETE`). For
    `roundRenewing` it runs ONLY inside the lease, on the leased read and before `mutate`
    (complete's accounted-for gate).
  - `preview`: only when `?dryRun=true`; returns the 200 body, never persists or
    republishes.
  - `mutate`: in-memory changes under the lease; returns `Extra`. Its context's `brief`
    field is the fresh LEASED brief, set only for `roundAndBrief`/`roundAndBriefRollback`/`pureTrackEchoes`.
  - `afterCommit`: runs after the lease is released and before the republish, on the
    committed round (the object then republished and returned), which it may refresh. The
    executor contains any throw via `ctx.error`, so it never fails the write or skips the
    republish. It never runs for rejections or previews.
  - `afterResponse`: fire-and-forget follow-up on the committed round, started after the
    republish and after the 200 body is built, and never awaited. The executor
    (`fireAfterResponse`) contains a synchronous throw or a rejection via `console.error`
    (not `ctx`: the invocation has usually completed by then), so it never fails the write.
    It never runs for rejections or previews.
  - `respond`: shapes the success body (default: the round).
  `CreateHooks` differ: `scope` and `mutate` are required, `mutate` builds AND persists the
  new round, and `after` is best-effort follow-up (eager brief) run after the republish.
  There are three post-commit shapes: create's `after` (after the republish, awaited, not
  contained); `afterCommit` (before the republish, awaited, contained via `ctx.error`);
  `afterResponse` (after the republish, never awaited, contained via `console.error`;
  complete's season recompute).
- Per-strategy order:
  - `round`: requireId → requireCoordCaller → either preview (unleased read →
    assertCanManageRound → scope → limiter → assertFrom (transitions) → gate → preview) or
    `mutateRound{ [record reads] → assertCanManageRound → scope → limiter → assertFrom →
    gate → mutate → status = to (transitions) → [record writes] }` → translate →
    afterCommit → republish → afterResponse → respond. The
    round is read and the caller resolved exactly once.
  - `roundAndBrief` (brief-complete): requireId → requireCoordCaller → unleased pre-read →
    assertCanManageRound → scope → limiter → assertFrom → gate → [preview returns here] →
    `mutateRoundWithBrief{ beforeBrief: assertFrom again; mutate: mutate → status = to }`
    (the record reads the round, runs `beforeBrief`, reads the brief, runs `mutate`, then
    writes BRIEF then round) → translate → afterCommit → republish →
    afterResponse → respond. Brief first
    so a crash never leaves a BriefComplete round over an unfrozen brief.
  - `pureTrackEchoes` (unlock): requireId → requireCoordCaller → unleased pre-read →
    assertCanManageRound → scope → limiter → `mutateRoundWithPureTrackEchoes(id, step{
    assertFrom → gate → mutate → status = to })` (the record delegates to
    `mutatePureTrackEchoes`) → afterCommit → republish → afterResponse → respond. The call
    sits OUTSIDE `translateStorageError`, so a plain storage failure reaches
    `withErrorHandler`'s generic catch unchanged, as the pre-#277 handler did. An
    uncommitted mutation is a defensive 500 raised by the record.
  - `roundAndBriefRollback` (lock): requireId → requireCoordCaller → unleased pre-read →
    assertCanManageRound → scope → limiter → assertFrom → gate →
    `mutateRoundWithBriefOrRestore(id, name, { beforeBrief: assertFrom again; mutate:
    mutate → status = to })` (in `roundRecord.ts`: read round → `beforeBrief` → read brief →
    capture its raw bytes → `mutate` → write BRIEF then round; if the round write fails,
    restore the raw brief bytes under the brief lease, a failed restore emitting the
    reconcile event with `operation` = the row key, and rethrow) → non-`HttpError` →
    `persistFailure` (NOT `translateStorageError`; the record operation does not translate
    a missing round either) → afterCommit → republish → afterResponse → respond. No preview
    path. The record's lease primitive may re-run the step when a storage 409/412 escapes it,
    so `mutate` must be re-entrant.
  - `roundRenewing` (complete): requireId → requireCoordCaller → unleased pre-read →
    assertCanManageRound → scope → limiter → assertFrom → `mutateRoundRenewing{
    [record reads] → assertFrom again → gate → mutate → status = to → [record writes] }` →
    translate →
    afterCommit → republish → afterResponse → respond. No preview path; the gate runs
    only inside the lease; acquisition does not retry (as the pre-#276 handler).
  - `create`: requireCoordCaller → scope → limiter → mutate → republish → after → 201. No
    id guard, lease or translation.
- Why the pre-reads differ. Brief-complete keeps an unleased pre-read so preview and real
  path share one status gate and can fail before entering the lease; the real path then
  re-reads and re-runs `assertFrom` inside the lease (check-then-act, the status may move
  between pre-read and acquisition). Lock's pre-read feeds the scope check, the limiter,
  the from-gate and the gate's pilot-Snapshot fan-out, which must stay outside the lease;
  its leased re-read re-checks the status, as brief-complete's does. Complete's pre-read
  feeds the scope check, the limiter and the from-gate, so its rejections never take the
  renewing lease; its leased re-read re-checks the status and is the round the
  accounted-for gate and scoring see, so an edit that lands before acquisition is never
  stale-overwritten. Unlock's pre-read exists ONLY to feed
  `assertCanManageRound` before the limiter: `mutatePureTrackEchoes`
  (`lib/puretrackStatus.ts`, reached through the record's `mutateRoundWithPureTrackEchoes`)
  owns the whole read/clone/lease/write/rollback cycle and does
  its own read, so the one `assertFrom` runs inside its callback. The asymmetry is
  deliberate, not an oversight; it also means a missing round 404s at the pre-read before
  `ensureBriefExists` could placeholder-create a brief for it.
- Previews are unleased. Reopen's and brief-complete's `preview` runs on
  `readRoundTranslated(id)`, which wraps the record's `readRound` (an unleased read whose
  missing round is the record's 404) in `translateStorageError`, never inside
  a lease. There's no lease-scoped try/catch around that branch, so scope errors are not
  wrapped or translated: an `HttpError` propagates as-is and anything else falls to
  `withErrorHandler`'s generic catch-all.
- `mutationRateLimit` runs via `chargeLimiter` INSIDE the lease on the `round` strategy,
  **deliberately**; don't hoist it into the handler. `rateLimit.ts:138-164` requires the
  fine scope check to resolve BEFORE the limiter ("a forbidden caller must get 403, never
  429"), and with one read the round is only in hand under the lease. Safe because
  `withLeaseOnClient` releases in a `finally` (`blob.ts:319-331`) and the limiter is a
  synchronous in-memory token bucket with no I/O. `_evidence.issue8.test.ts`'s
  `coord-scope` cases enforce the 403-before-429 order.
- `translateStorageError(err)` maps a failure the record did not answer itself: an
  `HttpError` (including the record's own 404) passes through, an `UntranslatedHookError`
  is unwrapped to its original cause, and anything else is `500 INTERNAL`. It does no 404
  detection of its own; that lives in `roundRecord.ts`.
- **Single-occurrence invariant**: `roundTransitions.ts` contains exactly one literal each
  of `mutationRateLimit(req, caller, spec.endpoint, spec.tier)`, `getCallerIdentity(`,
  `updateRoundsIndex(` and `"MISSING_ROUND_ID"`, and contains none of the storage needles
  (n3: blob paths, lease primitives, `readJson(`/`writePrivateJson(`, the reconcile event,
  `"Round not found"`, the storage imports) and imports `./roundRecord.js` (n4). The
  reconcile event and the renewing-lease call are pinned single in `roundRecord.ts` (k4,
  m4; see the roundRecord section).
  `roundsMutate.ts` holds none of lock's lease or rollback code (`withRoundAndBriefLease(`,
  `downloadToBuffer` and `crossBlobReconcileRequired` are absent) and no round-write
  preamble token at all.
  `functions/__tests__/roundWriteContract.test.ts` pins all of these. Every strategy
  funnels through `republish` (called by `republishAndRespond`, or directly by create),
  outside the lease and every try/catch, so a failing republish reaches the generic catch.
  A routed handler must NOT call `updateRoundsIndex` itself.
- **Accepted deviations from pre-#277 behaviour (E1-E4)**, written down so they aren't
  "fixed" or rediscovered:
  - E1: `updateRound` with no `id` now 400s `MISSING_ROUND_ID` before auth (the `round`
    strategy runs `requireId` first). Unreachable through the registered `rounds/{id}` route.
  - E2: under concurrent writers a would-be 403/429/409 on `updateRound` can surface as
    `500 INTERNAL` (see #293 below).
  - E3: race-only. Reopen's and brief-complete's previews gate on ONE pre-read instead of
    the old two reads, so they differ only if a write lands between where those reads were.
  - E4: a route id rejected by `assertSafeBlobPath` (e.g. `a@b`) now returns
    `400 INVALID_BLOB_PATH` (was `500 INTERNAL` via the deleted `assertManageableRound`)
    on `update`, `briefComplete` (+preview), `unlock` and reopen's preview, matching the
    pure transitions.
- **Accepted deviations from lock's pre-#275 behaviour (L1-L4)**:
  - L1: the status 409 now carries `detail` (`Expected status BriefComplete, got <status>`,
    via `assertFrom`/`expectedStatusDetail`); the old body's detail was normalised away.
  - L2: race-only. The in-lease status re-check's detail is `expectedStatusDetail(...)`
    instead of `"Round status changed concurrently"`; still `409 CONFLICT`.
  - L3: a route id rejected by `assertSafeBlobPath` now returns `400 INVALID_BLOB_PATH`
    (was `500 INTERNAL` from lockRound's catch-all pre-read), matching E4.
  - L4: a throw from post-commit work now returns 200, still republishes and logs via
    `ctx.error` (was a 500 that skipped the republish). Reachable only by a synchronous
    throw; every real post-commit callee is `async` and already caught.
- **Accepted deviations from complete's pre-#276 behaviour (C1-C4)**:
  - C1: the status 409 now carries `detail` (`Expected status Locked, got <status>`, via
    `assertFrom`/`expectedStatusDetail`); the old returned body's message was normalised away.
  - C2: race-only. The in-lease status re-check's detail is `expectedStatusDetail(...)`
    instead of `"Round must be Locked to complete (currently X)"`; still `409 CONFLICT`.
  - C3: a route id rejected by `assertSafeBlobPath` now returns `400 INVALID_BLOB_PATH`
    (was `500 INTERNAL` from completeRound's catch-all pre-read), matching E4/L3.
  - C4: a synchronous throw from the post-response recompute call is contained: 200,
    still republished, logged via `console.error` (was a 500 after the commit and the
    republish). Unreachable in practice: `recomputeSeason` is `async`, and its rejection
    keeps the `[completeRound] recomputeSeason(<year>) failed:` log line.
- **#293 applies only to the `round` strategy.** There, rejected requests (403/429/409)
  contend for the round lease and the record's `mutateRound` takes `withPrivateLease`, which
  does NOT retry, so a lost race escapes
  as a non-404 non-`HttpError` and `translateStorageError` maps it to `500 INTERNAL`.
  `mutateRoundWithBrief`/`mutateRoundWithBriefOrRestore` take `withRoundAndBriefLease`, which
  nests two `withPrivateLeaseRetry` calls that retry 409/412
  with backoff (`blob.ts:286-304,464-473`), so brief-complete and lock don't pay this cost; unlock
  delegates its lease to `mutatePureTrackEchoes`. Making `round` acquisition retry without
  re-charging the limiter is [#293](https://github.com/BritishClubChallenge/bccweb2/issues/293).
  Complete's `roundRenewing` lease (`mutateRoundRenewing`) does not retry acquisition either, exactly as the
  pre-#276 handler: a lost race is `500 INTERNAL`, but only real completes contend,
  because its 403/429/409-status rejections resolve on the unleased pre-read.
- Adding a write: add a `RoundWriteName`, one `ROUND_WRITES` row and the handler's hooks,
  reusing the shared preamble, translation, limiter and republish. When no existing lease
  strategy fits, add one record operation in `roundRecord.ts` (it owns the paths, the lease
  primitive and any missing-round mapping) plus one runner, with one lease value and one
  dispatch branch, reusing
  `requireId`, `requireCoordCaller`, `readRoundTranslated`, `chargeLimiter`, `assertFrom`
  and `republishAndRespond`, as `roundAndBriefRollback` (#275) and `roundRenewing` (#276)
  did; keep the counted literals single (`roundWriteContract.test.ts`).
- `expectedStatusDetail(from, actual)` — the exact 409 detail string
  (`Expected status X or Y, got Z`). Its only call site is `assertFrom`, which the preview
  and real paths share, so the two can't drift; it stays exported for tests.

## signTofly/ — sign-to-fly workflow

- `ledger.ts` — signature path builders, `read/write/listSignaturesForRound`,
  `listSignaturesForOccupancy` (one `teamId:place:pilotId` prefix), `buildSignaturePayload`
  (brief+wording hash, IP, UA), `extractIp` (`x-forwarded-for` → `x-azure-clientip`). Writes
  are create-only. The signature payload's `briefVersion` is what every rule reads; writers
  derive the path from it. All signature `listBlobsFlat` listing stays in this file.
- `wording.ts` — `getActiveWording`/`getWording(version)`/`addWordingVersion`/`listWordingVersions`;
  missing pointer → `503 WORDING_NOT_SEEDED`.
- `briefVersion.ts` — `MATERIAL_BRIEF_FIELDS`, `computeBriefHash`, `diffMaterialFields`
  (non-material edits don't change the hash).
- `resolution.ts` — single owner of the sign-to-fly rule. `signatureLedgerView(signatures)`
  returns a `SignatureLedgerView` (`hasSignedAnyVersion(occupancy)`,
  `resolveAgainst(brief)`); `resolveAgainst` returns a `SignToFlyResolution` (`briefVersion`,
  `isSigned`, `unsignedSlots`, `applyTo`, `demoteSuperseded`). Legacy signatures
  (`briefVersion === null`) are ignored. The latest signature per occupancy follows one total
  order: higher `briefVersion` wins, then later `signedAt` (null lowest), then higher `id`.
  Four consumers route through it so the flags and gates cannot drift: the lock gate
  (`unsignedSlots` + `applyTo`), brief-complete including `dryRun` (`demoteSuperseded`), the
  reflect job (`applyTo`) and self-unregistration (`hasSignedAnyVersion` only). Two
  loaders: `readRoundSignatureLedger(roundId)` (round-wide) and
  `readOccupancySignatureLedger(...)` (occupancy-scoped). Neither lists blobs itself.
- `reflect.ts` — `reflectRoundSignToFly(roundId)` leases the round, reads the ledger inside the
  lease and applies `resolveAgainst(brief).applyTo(round)`; it **early-returns unless the
  round is `BriefComplete`**. `lockRound` runs the same resolution itself before the round
  leaves `BriefComplete` and throws `409 SIGNATURES_INCOMPLETE` on any unsigned Filled slot.
- `auditLog.ts` — `appendAuditLine(category,payload)` append-only NDJSON (`audit/<cat>-YYYY-MM-DD.jsonl`).

### Accepted deviations from pre-#279 behaviour (S1-S4)

- **S1** — `invalidatedSignatureCount` is counted per slot. Before, a round with two slots
  sharing `(team.id, placeInTeam)` could over-count through the `slotKey` map. That shape is
  possible: `teams.ts` pushes a new slot when `choosePlace` reuses an Empty place left by
  `clearRegistrationSlot` (`roundRegistrationRoster.ts`). Now each demoted slot counts once.
- **S2** — self-unregistration judges the signature version from the signature payload (the
  same as the lock gate) instead of the blob path. Path and payload agree for every writer.
- **S3** — self-unregistration now reads (and ignores) legacy `-vlegacy.json` blobs under the
  pilot's own occupancy prefix; more broadly, ANY blob under that prefix is now listed and
  schema-validated, including non-canonical names the old path regex never matched and so
  silently skipped. A malformed blob there surfaces as `500 DATA_SHAPE_INVALID`, as it
  already does for lock and reflect.
- **S4** — self-unregistration keys the occupancy ledger from the signature PAYLOAD
  `teamId/place/pilotId`, not the blob path. A blob stored under the occupancy prefix whose
  payload names a different team or place no longer blocks unregistration (the old lookup
  trusted the path for team/place and only required `payload.pilotId` to match). No writer
  produces such a blob: writers derive the path from the payload.
