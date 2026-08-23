# bccweb2

Competition management web app for the **British Club Challenge** (BCC) hang
gliding & paragliding league. React 19 SPA + Azure Functions v4 API, with all
data stored in Azure Blob Storage (no database). Replaces a legacy .NET app.

## Stack

- **Web**: React 19, Vite 8, React Router v8, TypeScript
- **API**: Azure Functions v4 (Node 24, ESM, programming-model v4), TypeScript
- **Storage**: Azure Blob Storage (two containers: `data` public, `data-private` private)
- **Auth**: HS256 JWT (bespoke), `JWT_SECRET` from Azure Key Vault in prod
- **Hosting**: Static Web App (Standard tier, shared across environments) + Function App
  (Flex Consumption, one per environment), Terraform-managed
- **Email**: Azure Communication Services
- **Tests**: Vitest (unit/integration), Playwright (E2E)

## Repository Layout

```
apps/
  api/                  Azure Functions HTTP API   (@bccweb/api)
  web/                  React SPA                  (@bccweb/web)
packages/
  types/                Shared TS interfaces       (@bccweb/types)
  scoring/              Pure scoring functions     (@bccweb/scoring)
iac/                    Terraform (Azure)
scripts/                Migration, admin, privacy-scan utilities
tests/e2e/              Playwright browser tests
docs/runbooks/          Operational runbooks
```

npm workspaces. **Build order matters**: `types` → `scoring` → `api`; `types` → `web`.
The Makefile encodes this; prefer `make build` over `npm run build`.

## Prerequisites

Install with [mise](https://mise.jdx.dev/) (versions pinned in `.mise.toml`):

```sh
mise install
```

Provides Node 24.16.0, Terraform, and `azure-functions-core-tools` 4.12.0.

You also need: npm ≥ 10. No Docker required — Azurite (the Azure Storage
emulator) runs natively from the pinned `azurite` devDependency.

## Quick Start

```sh
# 1. Install dependencies
npm install

# 2. Build shared packages (required before first dev run)
make build

# 3. Copy local settings for the API
cp apps/api/local.settings.example.json apps/api/local.settings.json

# 4. Start the full stack (Azurite + API + web), all native
make dev
```

Then visit <http://localhost:5173>. `make dev` starts everything in one
foreground process; Ctrl-C stops it all.

### Run pieces individually

```sh
make azurite                   # Storage emulator on :10000 (--skipApiVersionCheck)
make dev-api                   # Functions host on :7071 (needs Azurite)
make dev-web                   # Vite dev server on :5173 (proxies /api, /blob)
```

## Common Commands

| Command | What it does |
|---|---|
| `make build` | Full build in dependency order |
| `make typecheck` | `tsc --noEmit` across all workspaces |
| `make test` | Run Vitest. **API tests require Azurite running (`make azurite`).** |
| `npm run test:watch` | Vitest in watch mode |
| `npm run e2e` | Playwright E2E (see [tests/e2e/README.md](tests/e2e/README.md)) |
| `npm run lint` | ESLint across all workspaces + `tests/e2e`/`scripts`, then the SPDX license-header check |
| `make clean` | Remove `dist/` and `*.tsbuildinfo` |

Single test file: `npx vitest run path/to/file.test.ts`.

## Data Model

Two Azure Blob containers, created by [`scripts/init-storage.mjs`](scripts/init-storage.mjs):

- **`data`** — public read, SPA fetches JSON blobs directly (results, seasons, indexes).
- **`data-private`** — API-only, requires JWT. Holds PII (pilot profiles, users,
  auth tokens, full round details, briefs).

A PR-gated [privacy scanner](scripts/privacy-scan.mjs) fails CI if PII fields
leak into the public container.

Atomic updates use 30-second blob leases — see `withLease()` /
`withPrivateLease()` in [`apps/api/src/lib/blob.ts`](apps/api/src/lib/blob.ts).

## Auth & Roles

| Role | Capabilities |
|---|---|
| `Admin` | All admin pages, all writes |
| `RoundsCoord` | Manage rounds + club teams for own `clubId`; uses `/club` self-service page |
| `Pilot` | Read authenticated endpoints, edit own profile |
| anonymous | Read public blobs only |

Tokens live in `localStorage` (`bcc_access_token`, `bcc_refresh_token`,
`bcc_identity`). Access tokens last 1 h, refresh tokens 30 d.

## Deployment

Three GitHub Actions workflows, all authenticating to Azure via **OIDC**
(per-env managed identities — no static credentials in the repo), each a thin
caller of a reusable workflow:

- [`deploy-staging.yml`](.github/workflows/deploy-staging.yml) — every merge to `main` deploys to `staging`, via [`deploy-app.yml`](.github/workflows/deploy-app.yml): Functions zip-deploy + SWA backend-link deploy with smoke tests
- [`deploy-prod.yml`](.github/workflows/deploy-prod.yml) — publishing a GitHub release deploys to `prod`, via the same `deploy-app.yml`, after a release-ancestry check (commit must be on `main`)
- [`terraform.yml`](.github/workflows/terraform.yml) — manual plan/apply of any root (`shared`/`staging`/`prod`), via [`terraform-run.yml`](.github/workflows/terraform-run.yml); also the drift-reconcile path

Infrastructure is managed by Terraform in [`iac/`](iac/) — see [iac/README.md](iac/README.md) for the three-root layout (`bootstrap/` → `shared/` → `environment/`). The Static Web App is Standard-tier and shared across environments (`iac/shared`); each environment's Function App backend is linked to it imperatively via `az staticwebapp backends link` (part of `deploy-app.yml`). Secrets are seeded declaratively via AzAPI data-plane writes (no shell script).

There is **no auto-rollback**. A failed smoke test fails the workflow and
leaves the deploy in place for operator investigation —
see [`docs/runbooks/deploy-smoke-failure.md`](docs/runbooks/deploy-smoke-failure.md). The Function App is Flex Consumption and has no deployment slots, so a manual rollback always means redeploying the prior artifact.

## Operations

Runbooks in [`docs/runbooks/`](docs/runbooks/) cover alerts, cutover, DNS
cutover, GDPR erasure, privacy incidents, decommission, and the
round/club/pilot decision matrix.

## Documentation

- [AGENTS.md](AGENTS.md) — repo conventions, gotchas, test quirks, infra notes (also useful for humans)
- [apps/api/README.md](apps/api/README.md) — API test prerequisites
- [iac/README.md](iac/README.md) — Terraform bootstrap, secret rotation
- [tests/e2e/README.md](tests/e2e/README.md) — Playwright setup

## License

Mozilla Public License 2.0 (MPL-2.0) — see LICENSE. Every source file carries an SPDX header (`SPDX-License-Identifier: MPL-2.0`); run `npm run license:fix` to stamp new files. See the [License headers (SPDX)](AGENTS.md#license-headers-spdx) section in AGENTS.md for the full convention.
