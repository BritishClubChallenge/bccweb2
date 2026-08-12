# scripts — admin, migration, load-test, and CI-gate scripts

Node ESM scripts run from the root `bccweb2` package; `scripts/migrate/` is a standalone
package outside the workspace graph. See root [AGENTS.md](../AGENTS.md) for the storage/queue
architecture these scripts operate on, and
[docs/architecture/storage-and-queues.md](../docs/architecture/storage-and-queues.md) for
the full container/queue reference.

## Credential safety (`make seed`)

`make seed` bootstraps `admin@bcc.local` and writes its generated credential only to the
gitignored root `.dev-credentials` at mode 0600; the value is never logged. Subsequent
seed/load control scripts consume that file automatically. `ADMIN_PASSWORD` remains the
explicit override. Malformed, symlinked, foreign-owned, or non-0600 files fail before any
API/storage mutation — treat this as a hard security invariant, not a convenience check.

For `make docker-up`, prepare writes the override (when present) into that same private
bind-mounted file, never into Compose environment. Make passes only the host UID/GID to
the root `api-init` container; credential reads accept that exact host owner across the
Linux bind boundary while retaining the regular-file, no-follow, single-link, and 0600
checks. Docker Desktop root-owned mounts still satisfy the normal current-owner path.

## `init-storage.mjs` — fatal, uniform provisioning

Creates the two blob containers and all ten Storage Queues (see the architecture doc)
in Azurite, using only Node built-ins (Shared Key auth against the Blob/Queue REST APIs —
no SDK). All ten queues are created uniformly **fatally**: if the Queue service is
unreachable the script throws and exits non-zero, exactly like `round-brief-pdf`. Blob
containers are created earlier in the same run, so a queue-service outage still surfaces
as a hard failure rather than a silent partial success.

## Storage authentication for root scripts

Root-package operator scripts use `lib/storageClients.mjs`. Local/Azurite execution uses
`BLOB_CONNECTION_STRING` and `AzureWebJobsStorage`; remote keyless execution requires
`BLOB_STORAGE_ACCOUNT_NAME` for data blobs and `RUNTIME_STORAGE_ACCOUNT_NAME` for queues,
authenticated as the invoking operator/OIDC identity through `DefaultAzureCredential`.
Do not bind these scripts to the Function App managed identity or set
`STORAGE_UMI_CLIENT_ID` for them: that setting belongs to the API adapter. Persistent
remote data/queue/deployment-package roles belong to each environment's GitHub OIDC UMI,
whose object ID is the stamp's required `operator_principal_id`; a local human using
`az login` needs a separately approved grant. The Function UMI remains the workload
identity. Azure stamps unconditionally use managed identity with Shared Key disabled on
both accounts, with no identity or Shared Key toggles. Production is not deployed, but it
will receive this secure-by-default contract when applied. `init-storage.mjs` remains an
Azurite-only Shared Key REST bootstrap and deliberately does not use the adapter.

For the staging cutover, run one `environment/staging` apply through the manual
`terraform.yml` workflow (or locally), then redeploy through the existing staging deploy
path; a brief interruption is expected. Roll back with `git revert`, re-apply, and redeploy
the prior artifact. This is the complete operator procedure.

## `privacy-scan.mjs` — CI success gate

Fails CI if PII leaks into public blobs, the SPA bundle, or telemetry/log fixtures. Its
storage scan covers public **blob storage** only — it does **not** cover Storage Queues (see the
architecture doc's "Queue privacy" section for the compensating control: strict `.strict()`
job schemas in `apps/api/src/lib/{queue,rescoreJob}.ts` and
`packages/schemas/src/igcValidationJob.ts`, including the IGC-validation family's
`IgcValidationJobSchema`). PII field list lives in
[`scripts/lib/pii.mjs`](lib/pii.mjs) and must stay in sync with
`apps/api/src/lib/telemetryRedactor.ts`'s `PII_FIELDS`.

## `spdx-header.mjs` — SPDX checker

Bespoke, zero-dependency checker. Enumerates tracked files via `git ls-files`; chained
into `npm run lint` (local + the CI `lint` job — no separate workflow). See root
AGENTS.md's "License headers (SPDX)" section for the header format and scope.
`npm run license:fix` stamps/upgrades in place (idempotent); `license:check` verifies
only; `license:test` runs the checker's own `node:test` suite.

## `scripts/migrate/` — standalone package

Legacy .NET → blob migration tooling. It sits **outside** the root `workspaces` globs and
has its **own** `package-lock.json` (pulls `mssql`, kept out of the deployed tree). Root
`npm ci` skips it entirely; `.github/workflows/ci.yml` installs it separately to run its
unit tests. State lives under `.migration-state/` (gitignored). `scripts/admin/anonymize-pilot.mjs`
handles GDPR erasure — see `docs/runbooks/gdpr-erasure.md`.

## Load-test scripts

`prepare-loadtest.mjs`, `run-loadtest.mjs`, `set-captains-loadtest.mjs`,
`transition-loadtest.mjs`, `verify-loadtest-sign-artifacts.mjs`,
`verify-loadtest-signtofly.mjs`, `cleanup-loadtest.mjs` implement the phases the
persisted status ledger tracks (`prepare/register/captains/transition/sign/artifact/verify/cleanup`).
`make loadtest` is a single sequential Node orchestrator recipe
(`node scripts/run-loadtest.mjs`) — individual `loadtest-*` Make targets remain
diagnostic-only tools, not composable parallel steps. Full topology, fixture counts, and
gate thresholds live in [docs/runbooks/load-testing.md](../docs/runbooks/load-testing.md)
— read it before touching these scripts. `npm run loadtest:test`
(`scripts/__tests__/loadtest-*.test.mjs`) covers pure orchestration/artifact/static
contracts without k6 or Azurite; it also parses this repo's root AGENTS.md, `tests/load/README.md`,
and the load-testing runbook. It checks the phase sequence in each document, while other
policy claims are checked across their combined text; keep all three aligned.

## Other key scripts

`seed-fixtures.mjs` / `seed-rounds.mjs` / `seed-admin.mjs` / `seed-wording.mjs` — fixture
and reference-data seeding (see root AGENTS.md's `make seed` / `make seed-rounds`).
`audit-fixtures.mjs`, `wipe-fixtures.mjs`, `perf-check.mjs`, `admin-users.mjs` —
maintenance/diagnostic one-offs; read the file header comment before running any of them
against a non-local target.

`admin/move-manufacturers-to-public.mjs` performs the one-time, idempotent promotion of
`manufacturers.json`; follow [the runbook](../docs/runbooks/manufacturers-move.md).
`admin/reconcile-orphan-igcs.mjs` scans private `rounds/*.json` as the authoritative
IGC reference set, then reports unreferenced `flight-igcs/**` blobs older than 24 hours;
it is dry-run by default and deletes only with explicit `--delete` (see the privacy runbook).
`admin/redispatch-stuck-igc-validations.mjs` reports pending, non-manual IGC validation
attempts whose round has been unchanged for at least two hours and has no durable result;
it is dry-run by default and reuses the committed attempt ID only with explicit
`--redispatch` (see the privacy runbook).
`devtools/seed-qa-users.mjs` is test-user tooling, not production seeding.
