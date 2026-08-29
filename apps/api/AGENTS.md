# apps/api — Azure Functions v4 API

Node 24, ESM, TypeScript. Entry: [`src/index.ts`](src/index.ts) imports every
self-registering function entry module; helper modules are imported by their owner.
**A new entry module is dead unless added to `src/index.ts`.** See root
[AGENTS.md](../../AGENTS.md) for the monorepo build DAG and storage/queue architecture
(also in [docs/architecture/storage-and-queues.md](../../docs/architecture/storage-and-queues.md)).

## TypeScript: NodeNext import rule

`module: NodeNext` → every relative import MUST end in `.js`
(`import x from "./lib/blob.js"`), even though the source file is `.ts`. This is enforced
by the compiler, not a lint rule — a missing extension fails typecheck, not lint.

## Module map

`health`, `me`, `meProfile`, `rounds`, `roundsMutate`, `seasons`, `pilots`, `clubs`,
`sites`, `manufacturers`, `teams`, `flights`, `igc`, `manualFlight`, `rescoreRound`,
`admin`, `adminWording`, `brief`, `puretrack`, `authFunctions`, `signatures`,
`roundRegistration`, `clubTeams`, `seasonClubs`, `pilotSeasonClubs`, `teamsCaptain` are
HTTP handlers. See
[`src/functions/AGENTS.md`](src/functions/AGENTS.md) for handler conventions and the
non-obvious file map.

Five queue-trigger modules (see the architecture doc for the flows they drive):

- `briefPdf` — `round-brief-pdf` + `-poison` (first non-HTTP triggers in the codebase).
- `signaturesReflect` — `signtofly-reflect` + `-poison`.
- `rescoreWorker` — **single** `app.storageQueue(...)` for `rescore-jobs` only; unlike the
  others it does NOT register a poison-queue consumer, because job failures are recorded
  on the job status blob rather than dead-lettered.
- `puretrackGroups` — `round-puretrack-group` + `-poison`, like `briefPdf`/`signaturesReflect`.
- `igcValidationWorker` — `igc-validation` + `-poison`; serializes and paces FAI
  signature checks, then re-scores the matching flight attempt with durable replay
  protection; poison handling marks matching pending attempts as worker-failed.

Lib helpers live in [`src/lib/AGENTS.md`](src/lib/AGENTS.md): `blob`, `blobJson`, `auth` +
`authHelpers`, `roundAuth`, `accountMutation`, `email`, `http`, `clientIp`, `pdf`,
`rateLimit`, `recompute`, `roundGates`, `roundTransitions`, `puretrack`, `teamCaptain`,
`briefPdf`, `queue`, `telemetry` + `telemetryRedactor`, `signTofly/*`.

## Auth

Bespoke HS256 JWT (`JWT_SECRET` env, ≥32 chars). Access token 1h, refresh 30d. Roles
`Admin`, `RoundsCoord`, `Pilot`. `getCallerIdentity(req)` returns
`CallerIdentity | null`; `RoundsCoord` users have a `clubId` scoping their writes.

## Env

Storage has a dual-mode application seam. Local/dev/Azurite uses `AzureWebJobsStorage` and
`BLOB_CONNECTION_STRING` from [local.settings.example.json](local.settings.example.json).
Deployed Azure is secure-by-default and gives the Functions host `AzureWebJobsStorage__accountName`,
`AzureWebJobsStorage__credential=managedidentity`, and `AzureWebJobsStorage__clientId`;
the API SDK seam uses `RUNTIME_STORAGE_ACCOUNT_NAME`, `BLOB_STORAGE_ACCOUNT_NAME`, and
`STORAGE_UMI_CLIENT_ID`. The Function UMI authenticates deployed host, queue, and data
access; it is not the staging GitHub OIDC operator UMI used by workflows/scripts.
`storageClients.ts` owns this mode selection and fails on incomplete identity settings.
Other settings are
`BLOB_CONTAINER_NAME` (`data`), `BLOB_PRIVATE_CONTAINER_NAME` (`data-private`),
`JWT_SECRET`, `APP_URL` (the deployed public SPA origin used for verification/reset email
links), `ACS_CONNECTION_STRING`, `ACS_SENDER_ADDRESS`,
`PURETRACK_*`, `FAI_VALI_ENABLED`, `FAI_VALI_BASE_URL`, `FAI_VALI_TIMEOUT_MS`.
Terraform sets deployed `APP_URL` from the required `app_url` input. Copy the example →
`local.settings.json`; local Azurite remains connection-string based and need not set
`APP_URL` because auth links fall back to `http://localhost:5173`.

## Testing — gotchas

Vitest ([vitest.config.ts](vitest.config.ts)):

- **Per-file Azurite containers**: each test file gets its own `test-data-<rand>` /
  `test-priv-<rand>`, deleted in `afterAll`; stale `test-*` (>1h) are swept from
  `127.0.0.1` only. Isolation must NOT rely on fresh-worker-per-file —
  `helpers/setup.ts` calls `resetBlobSingletons()` before container creation (contains
  blast radius: a file crashing mid-lease can't stall the next behind a 30s lease
  timeout).
- `@azure/functions` is **mocked** — `app.http()` populates a registry; tests invoke via
  `getRegisteredHandler(name)` (queue triggers via `getRegisteredQueueHandler(name)`).
  `email`, `pdf`, `puretrack` are mocked too. `helpers/seed.ts` prefers handlers but uses
  raw fixture access for bootstrap, controlled ID/team/state overrides, deliberately
  corrupt negative fixtures, and assertion reads; its banner is the allowlist.
- `fileParallelism: false` + `sequence.concurrent: false` — sequential for stable blob
  state.
- `TEST_BCRYPT_COST` honored only when `NODE_ENV === "test"`; else cost stays 12.
- 3 heavy tests excluded (`blob`, `puretrack`, `telemetry.integration`) — reasons inline;
  run via `make test-heavy`.
- PureTrack live-API tests are opt-in (`make test-integration`, needs `apps/api/.env` +
  network); self-skip without credentials, excluded from CI. See
  [README.md](README.md#puretrack-integration-tests-opt-in-live-api).

## New function module checklist

- [ ] Entry module: import it in `src/index.ts` and self-register.
- [ ] Helper module: import it from its owning entry module; do not self-register.
- [ ] Follow the handler shape / registration style in
      [`src/functions/AGENTS.md`](src/functions/AGENTS.md).
- [ ] If it's Admin-managed data, ship the operator UI in the same PR (root
      AGENTS.md's Feature Completeness Rule).
