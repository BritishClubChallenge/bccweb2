# Architecture: Storage and Queues

Human-facing reference for how bccweb2 stores data and moves work asynchronously.
There is no database: everything lives in Azure Blob Storage, and background work
runs over Azure Storage Queues in the same storage account. This doc is linked from
[AGENTS.md](../../AGENTS.md) and falls under its evergreen clause: if it drifts from
the code, fix it in the same change that revealed the drift.

## Containers

Two containers, created by [`scripts/init-storage.mjs`](../../scripts/init-storage.mjs):

- **`data`** (public, `publicAccess = "blob"`) — the SPA reads these blobs directly via
  `VITE_BLOB_BASE_URL` (dev: Vite proxies `/blob/* → /devstoreaccount1/data/*`). Contains
  indexes and derived data such as `rounds.json`, `seasons.json`, `seasons/{year}.json`,
  `results/{year}.json`, `pilots.json`, `clubs.json`, `club-teams.json`, `sites.json`, and
  `manufacturers.json`. **Never put PII fields
  here** — a PR-gated [privacy scanner](../../scripts/privacy-scan.mjs) fails CI if PII
  leaks into this container.
- **`data-private`** (private, API-only via JWT) — families include `rounds/{uuid}.json`,
  `pilots/{uuid}.json` (PII), `clubs/{uuid}.json`, `club-teams/{uuid}.json`,
  `sites/{uuid}.json`, `config.json`, `users/{uuid}.json`, `user-index.json`,
  `auth/{uuid}.json`, `auth/tokens/{hash}.json`, `round-briefs/{uuid}.{json,pdf}`,
  `frequencies/*`, `pilot-season-clubs/*`, `season-clubs/*`, `flight-igcs/*`,
  signature/wording ledgers, PureTrack records, and `rescore-jobs/*` status blobs.

Atomic read-modify-write on either container uses 30-second blob leases —
`withLease()` (public) / `withPrivateLease()` (private) in
[`apps/api/src/lib/blob.ts`](../../apps/api/src/lib/blob.ts).

### Two storage accounts per environment

`data`/`data-private` and the runtime/queue plane live in **two separate Azure Storage
accounts per environment** behind a dual-mode storage adapter:

- **Account A** `stbccweb<env>rt` — the Functions host's
  runtime storage, all ten queues below, and the Flex Consumption
  `deploymentpackage` blob container the Function App deploys from. Always
  `Standard_LRS`, public blob access disabled, no management lock.
- **Account B** `stbccweb<env>data` — the `data`
  (public) and `data-private` containers described above. Environment-derived
  LRS/GRS replication, public blob access enabled (for `data`), and a prod-only
  `CanNotDelete` lock.

### Secure-by-default identity access

Every environment stamp is unconditionally identity-based: Shared Key is disabled on
both the runtime and data accounts, and there are no storage-identity or Shared Key toggle
variables. The runtime and data accounts remain distinct: Functions host state, queues,
and `deploymentpackage` use the runtime account, while public/private application blobs
use the data account.

The Function App's UMI is the workload identity for host storage, Flex deployment,
runtime queues/tables, and data blobs (staging client ID
`cbbdfdb9-5743-46b9-8ad1-03b94303c0ef`). The host uses
`AzureWebJobsStorage__accountName`, `AzureWebJobsStorage__credential=managedidentity`,
and `AzureWebJobsStorage__clientId`; the API adapter uses
`RUNTIME_STORAGE_ACCOUNT_NAME`, `BLOB_STORAGE_ACCOUNT_NAME`, and
`STORAGE_UMI_CLIENT_ID`. The required `operator_principal_id` for each environment is the
object ID of that environment's GitHub OIDC/Terraform UMI. In staging this is
`4eabcaaf-5340-41b7-9ed2-7b47ebeaa7cd`; it authenticates deployment and remote operator
scripts and receives only its queue, data-blob, and `deploymentpackage` grants. It must
not be confused with the Function UMI client ID.

Local development, Docker, tests, and Azurite are the deliberate exception: they retain
`AzureWebJobsStorage` and `BLOB_CONNECTION_STRING` and do not require Azure identities.
Production is not deployed and must not be described as already keyless; its first apply
will create the same secure-by-default identity configuration.

### Staging cutover and rollback

Cut staging over with one `environment/staging` `terraform apply`, using the manual
`.github/workflows/terraform.yml` workflow or the equivalent local command, then redeploy
through the existing `deploy-staging.yml` → `deploy-app.yml` path. A brief staging
interruption between the infrastructure apply and application redeploy is acceptable and
expected. Afterward, dispatch `staging-storage-operator-smoke.yml` to run the non-mutating
queue verifier and dedicated blob/queue canaries.

Rollback is source-driven: `git revert` the secure-storage change, re-apply the reverted
environment configuration, and redeploy the prior artifact. There are no storage-auth
toggle variables or alternate transitional procedures.

## Schema layer

Schema-backed domain blob families have canonical Zod schemas in `packages/schemas` and
use `readJson(client, Schema)` plus `writeJson` / `writePrivateJson` (see
`apps/api/src/lib/blobJson.ts`). Operational/control records such as rescore status blobs
may use documented raw JSON and are outside `BLOB_SCHEMA_MODE`; raw helpers also remain
valid for non-JSON artifacts and explicitly justified lease/index operations.

- **`BLOB_SCHEMA_MODE`** (Function App env): `observe` (default) heals bad shapes in
  memory and emits telemetry only; `enforce` writes schema-parsed output, stripping
  unknown keys for `.strip()` objects and rejecting them for `.strict()` objects. This
  is an app setting, not a redeploy — flip it per `docs/runbooks/alerts.md`.
- **WingClass break-glass**: adding a `WingClass` requires, in order, types → schema →
  API deploy → admin UI emitting the new key. Doing it out of order means `enforce`
  mode will reject or strip the field.
- **`DATA_SHAPE_INVALID`**: a server-side data-invariant violation. The response body is
  `{error, path, schema}` — never field values (actual values are logged server-side
  only).
- **Test-fixture raw access**: `apps/api/src/__tests__/helpers/seed.ts` prefers handlers,
  but its banner allows bootstrap, controlled fixture overrides, deliberately corrupt
  negative fixtures, and assertion reads. A new category must update the banner and this
  section.

## Storage Queues

Ten queues, all in Account A (`stbccweb<env>rt`, the runtime account — see
"Two storage accounts per environment" above), across five families, each a main queue
plus a `-poison` dead-letter queue (`maxDequeueCount=5` in `host.json`). In Azure, the
`queue_service` and ten queue resources in
[`iac/environment/modules/stamp/storage.tf`](../../iac/environment/modules/stamp/storage.tf)
provision all ten. Locally, `init-storage.mjs` creates the same ten queues (plus the
`data`/`data-private` blob containers) against Azurite, since there's no Terraform apply
in that path:

| Family | Main queue | Poison queue |
|---|---|---|
| Brief PDF | `round-brief-pdf` | `round-brief-pdf-poison` |
| Sign-to-fly reflect | `signtofly-reflect` | `signtofly-reflect-poison` |
| Rescore | `rescore-jobs` | `rescore-jobs-poison` |
| PureTrack group | `round-puretrack-group` | `round-puretrack-group-poison` |
| IGC validation | `igc-validation` | `igc-validation-poison` |

The Functions host dead-letters only messages whose final invocation still throws.
Workers normally catch terminal domain failures and record status/telemetry instead, so
poison queues are fallbacks for uncaught host/handler failures rather than a complete
inventory of jobs that exhausted ordinary retries.

`init-storage.mjs` creates all ten uniformly and fatally: if the Queue service is
unreachable the script throws and exits non-zero. Blob containers are created earlier in
the same run, so a queue-service outage still surfaces as a hard failure rather than a
partial success.

**Connection invariant**: every producer and every `app.storageQueue` trigger reaches the
same runtime account (`stbccweb<env>rt`), but not through the same setting, and
`BLOB_CONNECTION_STRING` is blob-only in both modes. Using it for queueing would silently
break it.

- **Local/dev/Docker/Azurite**: producers (`apps/api/src/lib/queue.ts`,
  `apps/api/src/lib/rescoreJob.ts`, `apps/api/src/lib/igcValidationJob.ts`, via the
  `storageClients.ts` seam) and every trigger both read the `AzureWebJobsStorage`
  connection string, the only setting carrying a `QueueEndpoint` locally.
- **Deployed Azure**: the split is producer vs. trigger, not shared. Producers go through
  `storageClients.ts`'s `getRuntimeQueueClient`, which builds a `QueueClient` from
  `RUNTIME_STORAGE_ACCOUNT_NAME` plus `STORAGE_UMI_CLIENT_ID` (the Function UMI). The
  Functions host's `app.storageQueue` triggers instead resolve the hierarchical
  `AzureWebJobsStorage__accountName`, `AzureWebJobsStorage__credential=managedidentity`,
  and `AzureWebJobsStorage__clientId` settings directly. There is no plain
  `AzureWebJobsStorage` connection string in Azure, so do not restore one during or after
  the cutover.

**Queue privacy**: `privacy-scan.mjs` does not cover Storage Queues. The compensating
control is strict, `.strict()` job schemas in `apps/api/src/lib/queue.ts`,
`apps/api/src/lib/rescoreJob.ts`, and `packages/schemas/src/igcValidationJob.ts`:

- `BriefPdfJobSchema` — only `{roundId, briefVersion, pdfAttemptId}`.
- `SignToFlyReflectJobSchema` — only `{roundId}`.
- `PureTrackGroupJobSchema` — only `{roundId, attemptId}`.
- `RescoreJobMessageSchema` — only `{jobId, roundId, requestedAt}`.
- `IgcValidationJobSchema` — only `{roundId, teamId, place, flightId, validationAttemptId}`.

Any extra key is rejected at serialisation time, so PII can never enter these messages.

### Brief PDF flow

`POST /api/rounds/{id}/lock` sets `brief.pdfStatus = "pending"` and a fresh
`brief.pdfAttemptId` on the round blob, then enqueues
`{roundId, briefVersion, pdfAttemptId}`. The `briefPdf` queue-trigger consumer
(`apps/api/src/functions/briefPdf.ts`) renders and uploads the PDF, then atomically flips
`pdfStatus` to `ready`; only after that commit succeeds does it send configured email.
Readiness therefore confirms the artifact commit, not email delivery. Correctness is
guarded by `pdfAttemptId` plus an atomic compare-and-set commit
(`commitBriefPdfReady`) — **not** by `briefVersion` or `visibilityTimeout`. Status values:
`pending | processing | ready | failed`. Unlocking clears the PDF status fields.

### Sign-to-fly reflect flow

The sign endpoints enqueue `{roundId}` onto `signtofly-reflect`. The `signaturesReflect`
queue-trigger consumer (`apps/api/src/functions/signaturesReflect.ts`) re-materializes
`slot.signToFly` for the whole round by replaying the signature ledger (`signTofly/*`),
then writes the updated round blob. This keeps the HTTP response fast even though the
full-round recompute can be expensive. Operator recovery:
`POST /api/rounds/{id}/reflect-sign-to-fly` (Admin/scoped-coord) re-runs the reflect
synchronously and returns the corrected round.

### Rescore flow

Only the Admin rescore path (`POST /api/rounds/{id}/rescore`) enqueues
`{jobId, roundId, requestedAt}` onto `rescore-jobs` — single-pilot IGC upload stays
synchronous and never touches this flow. The `rescoreWorker` queue-trigger consumer
(`apps/api/src/functions/rescoreWorker.ts`) re-scores the round via the IGC-based scoring
path, writes the result, and updates `rescore-jobs/{jobId}.json`
(`queued | running | completed | partial | failed`). The Admin UI polls
`GET /api/rounds/{id}/rescore/{jobId}` for progress. Normal job failures are caught,
ACKed, and recorded as `failed` on the job status blob — they are **not** dead-lettered.
`rescore-jobs-poison` (provisioned in Terraform + `init-storage.mjs`) is a safety net for
catastrophic/uncaught host-level failures only. For failure triage, read the job status
blob plus App Insights.

### PureTrack group flow

Both the lock endpoint (`POST /api/rounds/{id}/lock`) and
`POST /api/rounds/{id}/puretrack/create-groups` set `round.pureTrack.status = "pending"`
and a fresh `pureTrack.attemptId`, then enqueue `{roundId, attemptId}` onto
`round-puretrack-group`. The `puretrackGroups` queue-trigger consumer
(`apps/api/src/functions/puretrackGroups.ts`) takes a global PureTrack mutation guard,
replaces then re-creates the round's PureTrack groups, and commits via the `attemptId` +
owner-token compare-and-set `commitPureTrackReady`
(`apps/api/src/lib/puretrackStatus.ts`), which flips `pureTrack.status` to `ready` only
while it is still `processing`. Status values: `pending | processing | ready | failed`.
Only failures that escape the worker after the final dequeue reach the poison queue.

### IGC validation flow

IGC upload and revalidation (`apps/api/src/functions/igc.ts`) set the flight's
`validation.signature = "pending"`, stamp a fresh `validationAttemptId`, and enqueue
`{roundId, teamId, place, flightId, validationAttemptId}` onto `igc-validation`. The
`igcValidationWorker` queue-trigger consumer
(`apps/api/src/functions/igcValidationWorker.ts`) re-reads the round, drops the message
(ACK, no-op) if the flight or its `validationAttemptId` has since moved on: a newer
upload or re-validation supersedes it, and reuses a durable
`readValidationResult(validationAttemptId)` record instead of re-calling FAI if one
already exists for this attempt.

Otherwise it acquires a single global blob-lease guard
(`igc-validation/active.json`, `acquireIgcValidationGuard`/`releaseIgcValidationGuard`
in `apps/api/src/lib/igcValidationJob.ts`) so at most one call to the FAI validator runs
at a time, then runs the pacing/staleness sequence deliberately split into three steps:
`waitForPace(leaseId)` first blocks until at least 2 seconds have passed since the
previous call recorded under this guard; the worker then re-reads the round and
re-checks the flight's identity and `isManualLog` state, and re-reads `config.json` for
`flightSignatureValidationEnabled`, immediately before egress, closing the window
between the pace wait and the outbound call. If validation has since been disabled, the
worker records `signature: "unverified", faiStatus: "DISABLED"` and skips the FAI call
entirely; see `docs/runbooks/privacy.md` for the accepted sub-second TOCTOU window this
leaves. Otherwise, right before the fetch, it calls `recordFaiCallStart(leaseId)` to
stamp the call-start timestamp that paces the next call, then calls
`validateIgcSignature` (`apps/api/src/lib/faiVali.ts`) against the flight's immutable
`igcPath` bytes, persists the outcome via `writeValidationResult` (create-only,
durable) before releasing the guard, then commits the result onto the round under a
private lease, re-scores via `scoreRoundEnforcingValidation`, and, for a `Complete`
round, it calls `recomputeSeason`. If the `recomputeSeason` step fails it is logged and
ACKed rather than retried, since the terminal validation result and round score are
already committed; an operator repairs the published league via
`POST /api/manage/rounds/{id}/recompute` (see `docs/runbooks/privacy.md` for the
outbound-egress and toggle implications of this flow).

Transport failures talking to FAI (timeout, 5xx, non-JSON, oversized file) are mapped to
a terminal `unverified` result and ACKed; they never retry the FAI call. Failures
reading the round or `config.json`, reading the IGC bytes, writing the durable result
record, committing the round under its private lease, `updateRoundsIndex`, or deleting
the durable result record all throw and are retried by the host. Any such retry replays
from the top of the message handler; because `readValidationResult` finds the durable
`writeValidationResult` record already in place *once that write has succeeded*, it
skips FAI again rather than making a duplicate call. The no-duplicate-egress guarantee
only holds from that point on: if `writeValidationResult` itself fails, or the worker
crashes after the FAI response but before the durable write lands, no record exists yet,
so the next dequeue calls FAI again. If that failure is transient, at most one repeated
upload happens before a later retry finds the (now-written) record. If it is persistent
(writeValidationResult fails on every dequeue), no durable record is ever written, so the
same IGC can be uploaded to FAI on every retry, up to `maxDequeueCount` (5) times, before
the message dead-letters to `igc-validation-poison`.

The `igc-validation-poison` queue has a dedicated consumer (unlike `rescore-jobs`, which
has none): on dequeue it marks the flight `signature: "unverified"`, `faiStatus:
"WORKER_FAILED"` so the flight is no longer stuck `pending` after retries exhaust, GCs
the orphaned durable result record for that attempt, and emits redacted telemetry (no
IGC bytes, no pilot PII). A flight left in this `unverified/WORKER_FAILED` state is
remediable by the operator via the normal Resubmit action, which stamps a fresh
`validationAttemptId` and re-enqueues onto `igc-validation`.

## Related runbooks

- `docs/runbooks/alerts.md` — `blob.healed` triage, `BLOB_SCHEMA_MODE` flip procedure.
- `docs/runbooks/privacy.md` — privacy incident response.
- `docs/runbooks/load-testing.md` — load-test topology and gates.
