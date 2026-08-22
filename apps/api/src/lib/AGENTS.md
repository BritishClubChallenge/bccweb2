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

## signTofly/ — sign-to-fly workflow

- `ledger.ts` — signature path builders, `read/write/listSignaturesForRound`,
  `getLatestSignature`, `buildSignaturePayload` (brief+wording hash, IP, UA), `extractIp`
  (`x-forwarded-for` → `x-azure-clientip`). Writes are create-only; path version = source of truth.
- `wording.ts` — `getActiveWording`/`getWording(version)`/`addWordingVersion`/`listWordingVersions`;
  missing pointer → `503 WORDING_NOT_SEEDED`.
- `briefVersion.ts` — `MATERIAL_BRIEF_FIELDS`, `computeBriefHash`, `diffMaterialFields`
  (non-material edits don't change the hash).
- `invalidate.ts` — `invalidatePriorSignToFlyFlags(...)` clears `slot.signToFly` when latest
  signature predates current brief version.
- `slotSignatureVersions.ts` — single owner of the brief-version rule: `slotKey`,
  `latestSignedVersions` (newest per `teamId:place`; equal versions break by `signedAt`),
  `currentBriefVersion`, `isSignedAtVersion` (pilot must match the slot's occupant),
  `isSupersededAtVersion`. `reflect.ts`, `completeness.ts` and `invalidate.ts` all route
  through it so the flags and the lock gate cannot drift apart.
- `reflect.ts` — `materializeSignToFly(round,brief,signatures)` writes `slot.signToFly` from
  the ledger; `reflectRoundSignToFly(roundId)` leases the round and applies it, and
  **early-returns unless the round is `BriefComplete`**.
- `completeness.ts` — `findUnsignedSlots(round,brief,signatures)` backs the lock gate:
  Filled slots with no current-version signature by their current pilot. `lockRound` throws
  `409 SIGNATURES_INCOMPLETE` on any hit and otherwise materializes the flags itself before
  the round leaves `BriefComplete`.
- `auditLog.ts` — `appendAuditLine(category,payload)` append-only NDJSON (`audit/<cat>-YYYY-MM-DD.jsonl`).
