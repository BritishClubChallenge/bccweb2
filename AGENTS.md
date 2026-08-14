# AGENTS.md — bccweb2

BCC (British Club Challenge) competition management web app. React 19 SPA +
Azure Functions v4 API, rewriting a legacy .NET app. **All data lives in Azure
Blob Storage — no DB.** Not yet live: no production data or deployments to
protect, so migration/cutover concerns are forward-looking, not remediation.

> **Keep all AGENTS.md files evergreen.** Source of truth for repo conventions. If any
> statement here no longer matches the code (stale versions, renamed/added/removed
> modules, changed build steps or paths), VERIFY against the files and UPDATE it in
> the same change that revealed the drift — don't just flag it. Accuracy is part of "done".
> This extends to the human-facing docs linked from any AGENTS.md, including
> [docs/architecture/](docs/architecture/) and [docs/runbooks/](docs/runbooks/): if a
> linked doc drifts from the code, fix it in the same change that revealed the drift.

## Monorepo Layout (npm workspaces)

```
apps/api/         @bccweb/api      — Azure Functions v4 HTTP API (Node 24, ESM, TS)
apps/web/         @bccweb/web      — React 19 SPA (Vite 8, React Router v8, TS)
packages/types/   @bccweb/types    — Shared TS interfaces (no runtime deps)
packages/schemas/ @bccweb/schemas  — Zod schemas, one per blob family (the schema layer)
packages/scoring/ @bccweb/scoring  — Pure scoring: scoreRound(), computeLeague()
iac/              Terraform (Azure), 3 roots (bootstrap/shared/environment)
scripts/  Admin/migration/privacy-scan
tests/e2e/        Playwright E2E (`npm run e2e`)  dist/web/ Vite build output (→ SWA)
docs/architecture/ Human-facing design docs (storage-and-queues.md)
docs/runbooks/    Operational runbooks (alerts, cutover, privacy, load-testing, ...)
```

**Build DAG**: `types → schemas → {scoring, api, web}`; `scoring → api`. Consumers
resolve `@bccweb/*` from each package's `dist/` (`main`/`types` fields), so a
dependency MUST be built before its dependents typecheck. Prefer `make build`
(encodes the order) over `npm run build`; after editing types/schemas, rebuild them
first. `make clean` deletes `dist/` + `*.tsbuildinfo` (stops stale incremental builds).

## Toolchain (pinned in `.mise.toml`)

Node 24.16.0, Terraform `1` (`.mise.toml`; all `iac/` roots/modules pin
`required_version = "~> 1.11"`; Terraform is provisioned by mise in CI via the
`./.github/actions/setup-node-mise` composite — there is no `hashicorp/setup-terraform`
step anywhere in this repo), `azure-functions-core-tools`
4.12.0, npm 11 (ships with Node 24). `mise install` brings these up.

## Dependency management

One root [`package-lock.json`](package-lock.json) for the whole workspace graph — npm
hoists + dedupes so shared tooling resolves to one version and there's a single
audit/Dependabot surface. **Do not split per-app lockfiles** (breaks `@bccweb/*`
symlinking, drifts versions). [`.npmrc`](.npmrc): `engine-strict` + `save-exact`
(no-caret). Updates are security-only via Dependabot (no `dependabot.yml`). Exception:
`scripts/migrate/` is a standalone package **outside** the `workspaces` globs with its
own lockfile (pulls `mssql`, kept out of the deployed tree); root `npm ci` skips it,
`ci.yml` installs it separately for migration unit tests. See
[scripts/AGENTS.md](scripts/AGENTS.md) for script-family guidance.

## Build / Test / Dev

| Command          | Notes                                                                     |
| ---------------- | ------------------------------------------------------------------------- |
| `make build`     | Full build in dependency order. Prefer over `npm run build`.              |
| `make typecheck` | `tsc --noEmit` across all workspaces.                                     |
| `make test`      | `vitest run` (workspace mode). **Requires Azurite up for API tests.**     |
| `make test-heavy`| The 3 excluded heavy API tests (see Testing).                            |
| `make dev`       | Full stack via Docker Compose (Azurite + API + Web/Caddy).                |
| `make dev-api` / `dev-web` | Functions host `:7071` (needs Azurite) / Vite dev `:5173`.      |
| `make seed`      | Generate/reuse private admin credentials, then seed fixtures.              |
| `make seed-rounds` | Optional 4-round browsing data; not a `make loadtest` prerequisite.       |
| `make loadtest`  | Sequential prepare/register/captains/transition/sign/artifact/verify/cleanup status transaction on a dedicated stack. |
| `npm run loadtest:test` | Pure load orchestration/artifact/static contracts; no k6/Azurite.      |
| `make clean`     | Removes `dist/` AND `*.tsbuildinfo`.                                      |
| `npm run e2e`    | Playwright (`tests/e2e/playwright.config.ts`, base URL `:5173`).          |
| `npm run lint`   | eslint all workspaces + `tests/e2e` + `scripts`; each workspace has its own `lint` (`eslint src --max-warnings 0`), then the SPDX header check (`license:check`). |

Single-file: `npx vitest run path/to/file.test.ts`. Watch: `npm run test:watch`.
Local dev needs Docker (or Podman) for Azurite.

**Load testing**: canonical fixtures are 500 pilots / 25 clubs / 50 teams / 10
pilots per team, with 25 coordinators and 50 captains. `make loadtest` is one Node
orchestrator recipe, so `make -j` cannot reorder phases; individual `loadtest-*`
targets remain diagnostic tools. Persisted status rows are exactly
`prepare/register/captains/transition/sign/artifact/verify/cleanup`; queue quiescence
is part of `verify`. Preparation checkpoints exact `loadRoundId` ownership plus a
non-secret target-stack digest before team creation; optional browsing-round seeds pair
their owned IDs with the same digest. The identity includes the API origin, storage/queue
endpoints, and effective public/private container names, and cleanup fails closed if the
current target differs. Register and sign never retry; production
`withPrivateLeaseRetry` owns lease contention. Sign selects 185 slots in disjoint
10/25/50/100 cohorts (315 remain false), with hard per-cohort 201-only,
p95<2s/p99<5s, zero-error/5xx gates. The exact verifier checks artifacts, ledger,
flags, replay and dedicated approximate reflect-queue quiescence. Pre-sign failure
cleans an owned checkpoint; verifier/queue failure preserves all state and forbids
cleanup. See `docs/runbooks/load-testing.md`.

Host-side local verification uses the queue-capable Azurite connection on `127.0.0.1:10001`
when `AzureWebJobsStorage` is absent. Remote targets require either that connection string
or `RUNTIME_STORAGE_ACCOUNT_NAME`; the verifier never falls back to blob-only
`BLOB_CONNECTION_STRING`.

Local `make seed` bootstraps `admin@bcc.local` and writes its generated credential only
to the ignored root `.dev-credentials` at mode 0600; the value is never logged.
Subsequent seed/load control scripts consume that file automatically. `ADMIN_PASSWORD`
remains the explicit override. Malformed, linked, foreign-owned, or non-0600 files fail
before API/storage mutation. Script guidance: [scripts/AGENTS.md](scripts/AGENTS.md).

For `make docker-up`, prepare writes the override (when present) into that same private
bind-mounted file, never into Compose environment. Make passes only the host UID/GID to
the root `api-init` container; credential reads accept that exact host owner across the
Linux bind boundary while retaining the regular-file, no-follow, single-link, and 0600
checks. Docker Desktop root-owned mounts continue to satisfy the normal current-owner path.

## License headers (SPDX)

Every comment-capable, git-tracked source file carries a two-line MPL-2.0 SPDX header (copyright line above licence line). The `//` form for TypeScript/JavaScript/MJS:

```
// SPDX-FileCopyrightText: <year> British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
```

Use `#` for Terraform/HCL/YAML/shell/TOML/Dockerfile.dev/Caddyfile/Makefile; `/* */` for CSS.

The bespoke, zero-dependency checker `scripts/spdx-header.mjs` enumerates tracked files via `git ls-files` and is chained into `npm run lint` (local + the CI `lint` job — no separate workflow).

- **New file?** Run `npm run license:fix` to stamp or upgrade in place (idempotent). `npm run license:check` just verifies. `npm run license:test` runs the checker's own node:test suite.
- **Enforcement is PRESENCE-ONLY**: requires the "British Club Challenge authors" copyright line and the `MPL-2.0` licence line; the year is informational and never policed.
- **Scope**: `apps/**`, `packages/**`, `iac/**`, `scripts/**` (including the standalone `scripts/migrate/` package — the gate reaches past eslint's ignore of it) + root config files.
- **Out of scope** (never stamped): JSON/`.jsonc` (no comment syntax), Markdown, declaration files (`*.d.ts`/`.d.mts`/`.d.cts`), `apps/web/index.html`, `.github/FUNDING.yml`, and anything gitignored.

## TypeScript Quirks

- **`apps/api`, `packages/{types,schemas,scoring}`** use `module: NodeNext` → relative
  imports MUST end in `.js` (e.g. `import x from "./lib/blob.js"`), even though sources are `.ts`.
- **`apps/web`** uses `module: ESNext` + `moduleResolution: Bundler` + `noEmit: true`.
  Imports still use `.js` extensions (`from "./pages/Home.js"`) — match that.
- `packages/{types,schemas,scoring}` are `composite: true` with project refs.
- Web build = `tsc --noEmit && vite build` (TS only typechecks; Vite emits).

## Data Storage (Azure Blob)

Two containers, created by `scripts/init-storage.mjs`: **`data`** (public, anon read,
SPA reads directly via `VITE_BLOB_BASE_URL`) and **`data-private`** (API-only via JWT,
holds PII). `withLease()` / `withPrivateLease()` in
[apps/api/src/lib/blob.ts](apps/api/src/lib/blob.ts) give atomic read-modify-write
(30s lease). **Never put PII fields in `data/` blobs** — a PR-gated
[privacy scanner](scripts/privacy-scan.mjs) fails CI if PII leaks into the public
container.

**Storage Queues**: ten queues, across five families — brief PDF, sign-to-fly reflect,
rescore, PureTrack group, IGC signature/date validation — each a main queue plus a
`-poison` dead-letter. Rescore normally records failures on its job-status blob; its
poison queue remains a host-failure safety net rather than an HTTP-visible retry path.
Locally, producers and triggers both use the `AzureWebJobsStorage` connection string. In
deployed Azure, producers use `RUNTIME_STORAGE_ACCOUNT_NAME` plus `STORAGE_UMI_CLIENT_ID`
(via `storageClients.ts`) while the host's triggers use the hierarchical
`AzureWebJobsStorage__accountName`/`__credential`/`__clientId` settings. Never use
`BLOB_CONNECTION_STRING`, which is blob-only and would silently break queueing. Queue job
schemas (`BriefPdfJobSchema`,
`SignToFlyReflectJobSchema`, `PureTrackGroupJobSchema`, `RescoreJobMessageSchema`,
`IgcValidationJobSchema`) are all `.strict()` so PII can never enter a queue message —
`privacy-scan.mjs` does not cover queues, so these schemas are the compensating control.

**Two storage accounts per env**: Account A `stbccweb<env>rt` is the runtime plane —
Functions host storage, all ten queues, and the Flex Consumption `deploymentpackage`
container. Account B `stbccweb<env>data` is the application blob plane — the `data`/
`data-private` containers only. The stamp is secure by default and unconditionally uses
managed identity with Shared Key disabled on both accounts; there are no storage-identity
or Shared Key toggle variables. `apps/api/src/lib/storageClients.ts` is the API's sole
SDK-construction seam: local/dev/Azurite keeps `AzureWebJobsStorage` and
`BLOB_CONNECTION_STRING`, while deployed Azure uses `RUNTIME_STORAGE_ACCOUNT_NAME`/
`BLOB_STORAGE_ACCOUNT_NAME` plus `STORAGE_UMI_CLIENT_ID`. The Functions host itself uses
`AzureWebJobsStorage__accountName`, `AzureWebJobsStorage__credential=managedidentity`, and
`AzureWebJobsStorage__clientId`. See
[docs/architecture/storage-and-queues.md](docs/architecture/storage-and-queues.md) for
the full split.

The Function UMI is the deployed workload identity for host/data access. The required
per-environment `operator_principal_id` is the object ID of that environment's GitHub
OIDC/Terraform UMI, used by remote operator scripts and deployment automation; it is not
the Function UMI client ID, and scripts must never impersonate the Function UMI. Local
humans use `az login` only after a separately approved data-plane grant. Production is
not deployed; when it is applied it receives this same secure-by-default identity model.
Local Azurite remains connection-string based.

Full container/family/flow reference (containers, all ten queues, brief PDF/sign
reflect/rescore/PureTrack/IGC-validation flows, CAS/attempt semantics, poison
behavior): [docs/architecture/storage-and-queues.md](docs/architecture/storage-and-queues.md).

### Schema layer

Schema-backed domain blob families have canonical schemas in `packages/schemas` and use
`readJson` / `writeJson` / `writePrivateJson`. Operational/control records such as rescore
status blobs may use documented raw JSON; deliberate raw operations must justify the
exception at their call site. `BLOB_SCHEMA_MODE` (`observe`/`enforce`),
the WingClass break-glass order, `DATA_SHAPE_INVALID`, and the `bootstrapAdmin`
allowlisted-exception rule are detailed in
[packages/schemas/AGENTS.md](packages/schemas/AGENTS.md) and the architecture doc — test
raw access in `apps/api/src/__tests__/helpers/seed.ts` is limited to its banner's
allowlist: bootstrap, controlled fixture overrides, deliberately corrupt fixtures, and
assertion reads. Any new category must update its banner and that section.

## API (`apps/api`)

Entry: [src/index.ts](apps/api/src/index.ts) imports every self-registering function entry
module; helpers are imported by their owner. **A new entry module is dead unless added to
`src/index.ts`.** Module map, NodeNext import rule, auth/env, and
test-isolation gotchas: [apps/api/AGENTS.md](apps/api/AGENTS.md). Handler conventions:
[apps/api/src/functions/AGENTS.md](apps/api/src/functions/AGENTS.md). Helper cheat sheet:
[apps/api/src/lib/AGENTS.md](apps/api/src/lib/AGENTS.md).

**Auth**: bespoke HS256 JWT (`JWT_SECRET` env). Access token 1h, refresh 30d. Roles
`Admin`, `RoundsCoord`, `Pilot`. `getCallerIdentity(req)` returns `CallerIdentity | null`;
`RoundsCoord` users have a `clubId` scoping their writes.

**Env** ([local.settings.example.json](apps/api/local.settings.example.json)):
local/dev uses `AzureWebJobsStorage` and `BLOB_CONNECTION_STRING`; Azure identity mode uses
`AzureWebJobsStorage__accountName`/`__credential`/`__clientId`,
`RUNTIME_STORAGE_ACCOUNT_NAME`, `BLOB_STORAGE_ACCOUNT_NAME`, and
`STORAGE_UMI_CLIENT_ID`. Both modes also use `BLOB_CONTAINER_NAME` (`data`),
`BLOB_PRIVATE_CONTAINER_NAME` (`data-private`), `JWT_SECRET` (≥32 chars),
`ACS_CONNECTION_STRING`, `ACS_SENDER_ADDRESS`, `PURETRACK_*`, `FAI_VALI_ENABLED`
(process-level kill switch for FAI signature validation), `FAI_VALI_BASE_URL`,
`FAI_VALI_TIMEOUT_MS`. Deployed Azure additionally sets `APP_URL` to the public SPA
origin used for verification/reset email links. Copy the example →
`local.settings.json`; local development does not need `APP_URL` because the auth helper
falls back to `http://localhost:5173`. Round-brief recipients are no
longer an env var — they live in `config.json`'s `roundBriefRecipients` (admin-editable);
leave it empty to disable brief email.

## Web (`apps/web`)

Entry: `src/main.tsx` → [`src/router.tsx`](apps/web/src/router.tsx). Pages under
`src/pages/{auth,rounds,results,pilots,admin,club}/`; theme in `src/bcc-theme.css`.
Router/hooks/`api.ts`/`useAuth`/roles/test details: [apps/web/src/AGENTS.md](apps/web/src/AGENTS.md).

## Feature Completeness Rule

Any new feature/endpoint MUST ship with the operator UI in the same PR (or an explicitly
linked follow-up in the same release). Admin-managed data (config, wording, reference data)
MUST have an admin page — an API without an operator UI is not done. Exceptions need a
documented rationale in the PR + an entry here.

## Testing — Critical Gotchas

**Vitest 4.1.9** (root devDep). Root [`vitest.config.ts`](vitest.config.ts) `test.projects`
covers `packages/{scoring,types,schemas}` + `apps/{api,web}`. API-specific gotchas
(per-file Azurite containers, mocked `@azure/functions`, heavy/integration exclusions):
[apps/api/AGENTS.md](apps/api/AGENTS.md). Web tests use `jsdom` +
`@testing-library/react`; aliases `@bccweb/types` to `packages/types/src` (no rebuild
needed). **E2E**: Playwright vs `E2E_BASE_URL` (default `:5173`); CI: 2 retries,
1 worker, `forbidOnly`.

## Infra / Deploy (`iac/`)

Terraform, THREE roots (see `iac/README.md`): `bootstrap/` (one-shot: tfstate storage, per-env
Terraform UMIs, the shared + per-env stamp resource groups, GitHub OIDC secrets, the
application deploy variables `TF_VAR_STAMP_RG_NAME`/`AZURE_LOCATION`/`SHARED_RG_NAME` — for
`deploy-app.yml` (and, for `SHARED_RG_NAME`, `pr-preview.yml`), not Terraform — and the non-secret, mode-0644
`iac/env/shared.generated.tfvars`, which must be reviewed and committed after bootstrap apply
because its UMI IDs do not exist beforehand) → `shared/` (the platform layer shared by `staging`/
`prod`: Log Analytics workspace, per-env Application Insights, Azure Communication Services,
and one Standard Static Web App with the prod custom domain/DNS; see `iac/shared/README.md`) →
`environment/` (the per-env application stamp: storage, Flex Consumption Function App, Key
Vault, alerts — reads only non-secret `app_insights_ids`/`acs_id` from `iac/shared`'s remote
state; one state, `<env>.tfstate`, in its own `tfstate-<env>` container). Each environment UMI has
Storage Blob Data Contributor only on its own tfstate container (plus `staging`/`prod` get
Storage Blob Data Reader on `tfstate-shared`); the previously documented
`tf_tfstate_blob_account_reader` never existed — it was a documentation myth, not an
account-level Reader grant. `jwt-secret` is generated declaratively (ephemeral `random_password` → KV
write-only), rotated via `jwt_secret_version`. KV seeding may 403 on first apply during RBAC
propagation — re-apply to recover.

The Function App is **Flex Consumption** (`Microsoft.Web/serverfarms` SKU `FC1`/`FlexConsumption`,
`Microsoft.Web/sites` with `functionAppConfig`) — no deployment slots, so a manual rollback means
redeploying the prior artifact, never a slot swap. The Static Web App is **Standard** tier, one
instance shared across environments (`iac/shared`); the per-env API backend is linked
imperatively via `az staticwebapp backends link` (Terraform cannot express a cross-resource
Functions↔SWA backend link) rather than a Terraform-managed backend resource.

Environment configuration is deterministic, non-secret Terraform topology (`shared_rg_name`,
`stamp_rg_name`, `tfstate_resource_group_name`, `tfstate_storage_account_name`) committed
directly in `iac/env/{shared,staging,prod}.tfvars`. Each environment's required `app_url` is
also committed there and Terraform publishes it to the Function App as `APP_URL`, the public
origin used for auth verification/reset email links. Staging uses
`https://nice-desert-0f55cb503-staging.westeurope.7.azurestaticapps.net`; production is
undeployed and is configured for `https://www.advance-bcc.uk`. Before the first production
apply/deploy, that hostname must resolve to and be bound on the shared SWA, and the existing
prod GitHub environment variable must remain `WEB_HOST=www.advance-bcc.uk`. Operator secrets
use explicit `TF_VAR_*` GitHub environment secret mappings in `terraform-run.yml`
(`ops_email`, `puretrack_*`,
`slack_webhook_url`). Shared plans additionally load the committed
`iac/env/shared.generated.tfvars`; environment plans never load it. There are no GitHub
Terraform-input variables. Terraform-native `validation` blocks replace the shell required-vars
pre-check that `terraform-run.yml` used to run. Secrets flow only through the workflow job environment.

The staging storage cutover is deliberately simple: run one `environment/staging` apply
through the manual `terraform.yml` workflow (or the equivalent local apply), then redeploy
the application through the existing `deploy-staging.yml` → `deploy-app.yml` path. A brief
staging interruption between apply and redeploy is acceptable and expected. A plain
`git revert` of the secure-storage change is not a safe rollback — Azure does not
reset `allowSharedKeyAccess` just because Terraform stops managing it, so the correct
procedure re-enables Shared Key deliberately before restoring key-based Function
settings. See [iac/README.md](iac/README.md#staging-storage-cutover-and-rollback) for
the full procedure.

CI (`.github/workflows/`) is DRY: three composite actions (`.github/actions/{setup-node-mise,
azurite,tf-setup}`) plus two reusable workflows (`deploy-app.yml`, `terraform-run.yml`) that the
thin per-trigger workflows call. `ci.yml` (every PR/push to `main`: typecheck, lint, full build,
Vitest incl. heavy tests with Azurite, `docker compose build`, plus a `terraform-contracts` job —
offline Terraform unit tests, fixture-sync diff, and the shared-resource/stamp-storage-split
contract scripts); `deploy-staging.yml` (push to `main` → `staging`, via `deploy-app.yml`);
`deploy-prod.yml` (GitHub release → `prod`, via `deploy-app.yml`); `terraform.yml` calls
`terraform-run.yml` for plan/apply per root+env; `pr-preview.yml` deploys a static-only SPA
preview to the shared SWA for same-repo PRs; `privacy-scan.yml` (Azurite + seed +
`privacy-scan.mjs`, fails on PII leak). Terraform itself comes
from mise (`.mise.toml` pins `terraform = "1"`) via the `setup-node-mise` composite — there is
no `hashicorp/setup-terraform` step anywhere in this repo. Prod SPA: Static Web App + routes in
[`staticwebapp.config.json`](apps/web/public/staticwebapp.config.json)
(kept in `apps/web/public/` so Vite copies it to the `dist/web` output-location root the SWA
deploy uploads — SPA fallback, security headers, `/api/*` → Function App); local Docker uses Caddy with the
same proxy shape ([`Caddyfile`](apps/web/Caddyfile)).

## Operations

Runbooks in `docs/runbooks/`: `alerts`, `cutover`, `decommission`, `deploy-smoke-failure`,
`dns-cutover`, `gdpr-erasure`, `load-testing`, `privacy`, `round-club-pilot-decision` — read the relevant
one before the matching op. Migration scripts in `scripts/migrate/` (legacy .NET → blob)
keep state under `.migration-state/` (gitignored); `scripts/admin/anonymize-pilot.mjs` for GDPR erasure.
After its deploy, run the tracked manufacturers promotion per `docs/runbooks/manufacturers-move.md`; script guidance: [scripts/AGENTS.md](scripts/AGENTS.md).

## Plan Execution (worktrees)

Execute saved plans (`.omo/plans/*.md`) in a **dedicated git worktree**, never the main checkout:

- Create under `.worktrees/<plan-name>` on a **new branch** off the base, e.g.
  `git worktree add .worktrees/pdf-stack-upgrade -b deps/pdf-stack-149-25 origin/main`.
  `.worktrees/` is gitignored — keep throwaway verification artifacts there, uncommitted.
- Ensure the plan uses CORRECT PATHS for the worktree (agents have edited the main checkout by mistake before).
- A fresh worktree has **no `node_modules`/`dist/`/`.codegraph/`** — run
  `npm ci && make build && codegraph init` before editing or typechecking (workspaces
  resolve `@bccweb/*` from `dist/`). After `codegraph init` the codegraph tools work scoped
  to that worktree.
- Do all work inside the worktree; commit only intended source files.
- After the **user approves the completion gate**, OFFER to run the `pr-flow` skill to open
  the PR and drive CI/Copilot review. Don't merge unless asked. On completion, fast-forward
  `main`, then `git worktree remove` + delete the branch.
