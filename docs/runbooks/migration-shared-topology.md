# Migration runbook: dev decommission → three-root shared topology

This runbook migrates bccweb2's infrastructure from the pre-refactor
two-environment shape (`dev` + `prod`, one `iac/environment` platform module
per env) to the three-root shape documented in [`iac/README.md`](../../iac/README.md):
`bootstrap/` → `shared/` (staging+prod) → `environment/` (per-env stamp, two
storage accounts, Flex Consumption).

The app is **not yet live** — there is no production traffic to protect and
no cutover-window pressure — but `dev`'s Azure resources are real and must be
torn down cleanly before the refactored bootstrap applies, because the
refactored bootstrap's resource map has no `dev` entry and no per-env
`platform` resource group. Applying it while `dev` still exists would orphan
or half-delete dev's live resources under Terraform's control, not clean
manual teardown.

**Order is the whole point of this runbook**: dev is destroyed FIRST, from a
checkout of the last pre-refactor commit, using that commit's OWN Terraform
config and an explicit backend pointer — never from `origin/main` after the
refactor merges, and never via the state-relocation subcommand (`terraform
state` + `mv`). Only after dev's
Azure resources are gone (and its tfstate footprint is pre-cleaned) does the
refactored bootstrap apply.

Follow the phases in order. Do not skip ahead to phase 4 (refactored
bootstrap apply) until phases 0–3 are each explicitly confirmed complete.

## Phase 0 — Back up every tfstate blob

Before touching anything, pull and archive every root's current remote
state, including dev's state at its **current live backend location** (not
a renamed/future one — dev still uses its own pre-refactor backend file at
this point).

```sh
mkdir -p .migration-backup

# dev — pull from its live pre-refactor backend (see phase 2 for the exact
# backend-config file used to reach it)
terraform -chdir=iac/environment init -reconfigure -backend-config=<dev's live backend file>
terraform -chdir=iac/environment state pull > .migration-backup/dev.tfstate.json

# prod (still on the pre-refactor two-root shape at this point)
terraform -chdir=iac/environment init -reconfigure -backend-config=../env/prod.backend.hcl
terraform -chdir=iac/environment state pull > .migration-backup/prod.tfstate.json

# bootstrap (local state — just copy the file)
cp iac/bootstrap/terraform.tfstate .migration-backup/bootstrap.tfstate
```

`dev`'s pulled state is a backup only — it is **never migrated** anywhere.
Dev is destroyed, not adopted. Retain `.migration-backup/` (gitignored;
`.worktrees/`-style throwaway location, or `.migration-state/` per the
scripts convention) until the whole migration is reviewed and closed out.

## Phase 1 — Record the pinned pre-refactor SHA

Dev's teardown must run against the **exact commit** whose Terraform config
still matches dev's deployed resources (the two-root shape: `iac/environment`
composing both a `platform` module and a `stamp` module, `dev` present in
`iac/bootstrap`'s `terraform_umis`/`github_environments`). Record it before
merging the refactor to `main`:

```sh
git log -1 --format=%H main   # the LAST commit before this refactor merges
# example: PRE_REFACTOR_SHA=3f9a1c2...
```

Write this SHA down (commit message, ticket, or `.migration-backup/PRE_REFACTOR_SHA.txt`).
`origin/main` is **mutable** — once the refactor PR merges, `origin/main`
contains the new bootstrap/shared/environment shape and no longer describes
dev's actual deployed resources. Every teardown command in phase 2 checks
out `$PRE_REFACTOR_SHA` explicitly, never `origin/main`.

## Phase 2 — Tear down dev from the pinned SHA

Do this from a throwaway worktree so the pinned checkout never touches your
working branch:

```sh
git worktree add .worktrees/dev-teardown $PRE_REFACTOR_SHA
cd .worktrees/dev-teardown
npm ci && make build   # the pinned config's own toolchain, not main's
```

Reconstruct dev's config at this pinned checkout. If the pinned SHA already
carries the committed-base / gitignored-local-overlay split (base
`iac/env/dev.tfvars` tracked, secrets in `iac/env/dev.local.tfvars`), only the
local overlay needs reconstruction — the committed base comes along with the
checkout. On an older pinned SHA where the whole file was gitignored, rebuild
it from the example (these values don't come along with the SHA either way):

```sh
cp iac/env/dev.tfvars.example iac/env/dev.tfvars
# fill in dev's real values: puretrack_*, ops_email, acs_sender_address, etc.
# (pull from the GitHub `dev` environment's variables/secrets if you no
# longer have a local copy — Settings → Environments → dev)
```

Initialize against dev's **current live backend explicitly** — do not rely
on whatever backend file happens to be committed at the pinned SHA if it has
since drifted; pin it by content:

```sh
terraform -chdir=iac/environment init -reconfigure -backend-config=../env/dev.backend.hcl
```

(`../env/dev.backend.hcl` is the backend file that was live and committed at
`$PRE_REFACTOR_SHA` — it points at dev's actual `tfstate-dev`/`dev.tfstate`
blob in the canonical account `stbccweb13afe`. If you're unsure it's still
accurate, compare against the phase-0 backup's remote address before
proceeding — `-reconfigure` forces Terraform to use the file's values
rather than any cached `.terraform/` state.)

Lift the locks and `prevent_destroy` guards blocking destroy, still at the
pinned SHA:

1. Dev's stamp `storage-nodelete` `CanNotDelete` lock (only present when
   `enable_delete_lock = true` for dev — check `iac/environment/modules/stamp/storage.tf`'s
   `storage_lock` resource at the pinned SHA):
   ```sh
   az lock delete --name storage-nodelete \
     --resource-group <dev stamp RG> \
     --resource <dev data storage account> \
     --resource-type Microsoft.Storage/storageAccounts
   ```
   (Or, if dev's config sets `enable_delete_lock = false`, there is no lock
   to remove — confirm via `az lock list --resource-group <dev stamp RG>`.)
2. Remove `prevent_destroy = true` from the dev **platform** module's
   Log Analytics workspace / Application Insights / ACS email service / ACS
   email domain resources (`iac/environment/modules/platform/main.tf` at the
   pinned SHA — the platform module only exists at this SHA; the refactor
   deletes it entirely). Edit the pinned checkout's file locally (do not
   commit — this checkout is throwaway):
   ```sh
   # in .worktrees/dev-teardown/iac/environment/modules/platform/main.tf
   # delete each `lifecycle { prevent_destroy = true }` block
   ```

Destroy the dev stamp + platform:

```sh
terraform -chdir=iac/environment destroy -var-file=../env/dev.tfvars -var 'terraform_principal_type=User'
```

Confirm the plan shows only dev resources being destroyed, then approve.
After this completes, dev's Azure **workload** resources (storage, Function
App, Key Vault, Log Analytics, Application Insights, ACS) are gone. Dev's
bootstrap-owned resource group(s) and UMI remain — pre-refactor bootstrap
created them and pre-refactor bootstrap's state (local, on `main`, not this
pinned checkout) still references them; they are cleaned up by the
refactored bootstrap apply in phase 4.

Return to the main worktree and remove the throwaway one once you've
confirmed the destroy succeeded:

```sh
cd /Volumes/code/bccweb2
git worktree remove .worktrees/dev-teardown
```

## Phase 3 — Pre-clean dev's tfstate footprint in bootstrap state

The bootstrap tfstate **storage account** carries a `CanNotDelete` lock
(`azapi_resource.tfstate_sa_lock`, `iac/bootstrap/main.tf` — see the
"CanNotDelete lock on the storage account" section) that is **inherited by
every child container and every role assignment scoped to those
containers**. If the refactored bootstrap apply (phase 4) tries to delete
dev's now-stale `tfstate-dev` container or dev's `tf_tfstate_blob_role`
assignment as part of dropping dev from its resource map, that delete will
fail against the lock and the apply will not complete cleanly.

Remove those two addresses from bootstrap's **local** state (still on
`main`, pre-refactor bootstrap state — this is a `state rm`, which only
un-tracks the address in Terraform's bookkeeping; it does **not** delete the
underlying Azure resource) before the phase-4 apply:

```sh
terraform -chdir=iac/bootstrap state rm 'azapi_resource.tfstate_container["dev"]'
terraform -chdir=iac/bootstrap state rm 'azapi_resource.tf_tfstate_blob_role["dev"]'
```

After this, the refactored bootstrap's plan (phase 4) no longer proposes
deleting either address — they're simply gone from Terraform's view, and the
now-orphaned-but-inert container + role assignment sit under the account
lock until an operator cleans them up.

**No state-relocation subcommand (`terraform state` + `mv`) anywhere in this
runbook.** Dev's state is discarded via `destroy` (phase 2) plus this
`state rm` (phase 3) — never moved into a new address, never pushed into
another root's state.

Optional out-of-band operator cleanup of the orphaned container + role
(safe to defer indefinitely — they're inert, cost nothing, and the account
lock already protects everything else):

```sh
az lock delete --name tfstate-sa-nodelete \
  --resource-group rg-bccweb-tfstate \
  --resource stbccweb13afe --resource-type Microsoft.Storage/storageAccounts

az storage container delete --auth-mode login \
  --account-name stbccweb13afe --name tfstate-dev
az role assignment delete \
  --assignee <dev UMI principalId> \
  --scope /subscriptions/<sub>/resourceGroups/rg-bccweb-tfstate/providers/Microsoft.Storage/storageAccounts/stbccweb13afe/blobServices/default/containers/tfstate-dev

az lock create --name tfstate-sa-nodelete --lock-type CanNotDelete \
  --resource-group rg-bccweb-tfstate \
  --resource stbccweb13afe --resource-type Microsoft.Storage/storageAccounts
```

Restore the lock immediately after (`az lock create` above) — do not leave
the account unlocked longer than the container/role delete takes.

## Phase 4 — Apply the refactored bootstrap

Now on `main` (post-refactor), from the normal working tree:

**Parity checklist — run before `terraform -chdir=iac/bootstrap plan`.** The
refactored bootstrap no longer publishes the deterministic-topology GitHub
variables (`TF_VAR_shared_rg_name`, `TF_VAR_tfstate_resource_group_name`,
`TF_VAR_tfstate_storage_account_name`) that an older bootstrap may have left
on the `staging`/`prod`/`shared` GitHub environments; the plan below will
propose deleting them. Before accepting those deletes, confirm the committed
files already carry the equivalent values, so nothing is lost when GitHub's
copy goes away:

- `iac/env/shared.tfvars` has the correct `shared_rg_name`.
- `iac/env/staging.tfvars` and `iac/env/prod.tfvars` each have the correct
  `stamp_rg_name`, `tfstate_resource_group_name`, and
  `tfstate_storage_account_name`.
- `iac/env/shared.backend.hcl`, `iac/env/staging.backend.hcl`, and
  `iac/env/prod.backend.hcl` each resolve to the same canonical bootstrap
  storage account and the correct per-environment container.

If any of these committed values are missing or don't match what bootstrap's
plan will delete, fix the committed files first and re-run the plan — do not
apply a plan that deletes a GitHub variable whose value isn't already
captured somewhere committed.

```sh
terraform -chdir=iac/bootstrap init -backend=false
terraform -chdir=iac/bootstrap plan   # review carefully before applying
```

Confirm the plan shows:
- **Deletes**: dev's now-empty `stamp-dev` resource group and `id-bccweb-terraform-dev`
  UMI (these are NOT under the tfstate-account lock — only the tfstate
  container/role from phase 3 were).
- **Deletes**: any of `TF_VAR_shared_rg_name`, `TF_VAR_tfstate_resource_group_name`,
  or `TF_VAR_tfstate_storage_account_name` still present on `staging`/`prod`/
  `shared` from a pre-refactor bootstrap apply — expected once the parity
  checklist above has passed, since the refactored config no longer manages
  these GitHub variables.
- **Creates**: `rg-bccweb-shared`, `id-bccweb-terraform-shared`, dev→staging
  rename artifacts (staging UMI/RG if not already adopted from dev's
  identity — see the plan's exact diff; T4 already renamed dev's UMI/RG to
  staging in config, so this may show as an in-place rename rather than a
  destroy+create depending on how `terraform_umis` keys were edited).
- **No delete** of `tfstate-dev` container or its role assignment (phase 3
  already removed them from state, so they don't appear at all).

Apply:

```sh
terraform -chdir=iac/bootstrap apply
```

This writes `iac/env/shared.generated.tfvars` (including the new `shared`
UMI's principal ID) as a non-secret mode-0644 file, and publishes the application deploy variables
`TF_VAR_STAMP_RG_NAME`/`SHARED_RG_NAME`/`AZURE_LOCATION` to `staging`/`prod`
(consumed by `deploy-app.yml`, not Terraform) — see `iac/README.md`'s
"GitHub Environment Variables & Secrets Contract" table for the complete
bootstrap-published set. `shared_rg_name`, `stamp_rg_name`, and the
`tfstate_*` values are deterministic once `terraform_umis`/
`github_environments` are fixed, so they're already committed in
`iac/env/{shared,staging,prod}.tfvars` — nothing to publish for them.

## Phase 5 — Operator DNS grant (only if using a prod custom domain)

Only after phase 4 completes does the **shared UMI exist** — `iac/shared`
(the shared UMI, Owner only on `rg-bccweb-shared`) cannot self-assign a role
on an external DNS zone, so this is a manual, out-of-band operator step:

```sh
SHARED_UMI_PRINCIPAL_ID=$(terraform -chdir=iac/bootstrap output -json terraform_umi_principal_ids | jq -r '.shared')

az role assignment create \
  --assignee-object-id "$SHARED_UMI_PRINCIPAL_ID" \
  --assignee-principal-type ServicePrincipal \
  --role "DNS Zone Contributor" \
  --scope /subscriptions/<sub>/resourceGroups/<dns-zone-rg>/providers/Microsoft.Network/dnsZones/<zone>
```

Skip this phase entirely if prod will not use a custom domain
(`production_hostname`/`dns_zone_name` left empty in `iac/env/shared.tfvars`).

The CNAME record-name computation in `iac/shared/dns.tf` correctly strips the
zone suffix with `trimsuffix(var.production_hostname, ".${var.dns_zone_name}")`,
producing the zone-relative name Azure DNS expects. If you populate
`production_hostname`/`dns_zone_name` as part of this migration, review the
shared Terraform plan and confirm the computed record name before applying.

## Phase 5.5 — Populate GitHub Secrets (deploy variables are automatic)

Authored non-secret config (`acs_email_domain`, `acs_sender_address`,
`production_hostname`, `dns_zone_name`, `dns_zone_resource_group_name`,
`allowed_origins`, `jwt_secret_version`, `acs_secret_version`,
`blob_schema_mode`, and friends) is **committed** in `iac/env/<env>.tfvars` —
there's nothing to enter in GitHub for these; both local applies and CI load
the same tracked file with `-var-file`. If a value needs to differ for this
migration (e.g. a real ACS email domain, or a prod custom domain), edit the
committed base file directly and commit that change; don't create a GitHub
entry for it.

Only two categories of GitHub environment entries exist, and only one of
them needs manual work before the shared/environment applies in phase 6:

- **Bootstrap-published deploy variables**:
  `TF_VAR_STAMP_RG_NAME`/`SHARED_RG_NAME`/`AZURE_LOCATION` are used by
  `deploy-app.yml`, not Terraform, and are already written by phase 4's
  bootstrap apply. `AZURE_LOCATION` is Sweden Central, matching the regional
  bootstrap/shared/application workload location. The Static Web App is the
  explicit West Europe exception because that service does not support Sweden
  Central. There are no GitHub Terraform-input variables.
- **Operator-set secrets** — populate these by hand. See the full table in
  [`iac/README.md`](../../iac/README.md#github-environment-variables--secrets-contract);
  summarized here:

| Environment | Secrets to add |
|---|---|
| `staging`, `prod` | `TF_VAR_ops_email` (a Secret, not a Variable — public repo), `TF_VAR_puretrack_api_key`/`_email`/`_password`, `TF_VAR_slack_webhook_url` (optional) |

Plus the app-deploy Variables `AZURE_FUNCTIONAPP_NAME`, `VITE_BLOB_BASE_URL`,
and `WEB_HOST` (prod only) — see below.

**The new `staging` GitHub environment inherits NONE of dev's operator
secrets.** Dev and staging are different GitHub environments (staging was
created/renamed by bootstrap in phase 4, or already existed from T4's
config) — every operator-set secret above must be entered fresh
for `staging`, even if the value happens to match what dev used to have.
Copy dev's values as a starting point if appropriate, but set them
explicitly; don't assume they carried over.

`VITE_BLOB_BASE_URL` for each app environment targets **Account B** (the
data account), e.g. `https://stbccweb<env>data.blob.core.windows.net/data`
— see phase 7 for the full per-env matrix and why this is Account B, not
Account A.

`WEB_HOST` is **prod-only** and required only when a custom
`production_hostname` is configured for prod (see phase 5 above). Its value
is that production hostname: `www.advance-bcc.uk`. Setting it
enables `deploy-app.yml`'s production-domain smoke gate, which checks the
health, seasons, and HTML responses on the real custom domain after a prod
deploy. If `WEB_HOST` is left unset, that smoke step is skipped by design —
only the default SWA hostname gets smoke-tested.

### Preview environment security preconditions (REQUIRED before `PREVIEW_ENABLED=true`)

[`.github/workflows/pr-preview.yml`](../../.github/workflows/pr-preview.yml)
deploys ephemeral PR previews to the shared SWA, but is gated OFF by the
`PREVIEW_ENABLED` variable until this phase's GitHub environment work is
done. `PREVIEW_ENABLED` MUST be set at the **repository** level (Settings >
Secrets and variables > Actions > Variables), not on the `staging`
environment: the gate is a job-level `if:`, and GitHub evaluates a job's `if:`
before that job's `environment:` (and its environment-scoped variables) is
loaded, so an environment-scoped `PREVIEW_ENABLED` would never be visible to
the check and the job would be permanently skipped. That gate is **not**
sufficient on its own: the job
checks out and builds PR-branch-controlled code inside a job that, as
currently wired, holds the `staging` environment's Azure OIDC identity — the
same Terraform user-assigned managed identity that is Owner on the staging
stamp resource group and Contributor on the shared ACS/SWA resources. The
job's same-repo check blocks forks, but not an unreviewed branch pushed by any
collaborator with write access, so as written this is a privilege-escalation
path, not just a preview convenience.

Before setting `PREVIEW_ENABLED=true` for real, both of the following are
REQUIRED, not optional:

1. **Dedicated least-privilege preview identity.** Create a separate
   GitHub environment (e.g. `preview`) backed by its own user-assigned
   managed identity, scoped to ONLY manage SWA preview environments on
   `swa-bccweb-shared` (`az staticwebapp environment create/delete` and
   `secrets list` on that one Static Web App). This identity must NOT be the
   staging stamp UMI — that identity's broader Owner/Contributor grants are
   exactly what makes the current wiring a privilege-escalation risk.
   Point `pr-preview.yml`'s `environment:` at this dedicated environment once
   it exists. This environment is deliberately **not** a bootstrap
   `terraform_umis` entry (see
   [`iac/bootstrap/README.md`](../../iac/bootstrap/README.md#adding-a-new-github-environment)
   for why that recipe grants the wrong kind of access here), so none of its
   variables/secrets are bootstrap-published — every one below must be set
   by hand on this new environment:
   - `SHARED_RG_NAME` — the same shared resource-group name bootstrap
     publishes to `staging`/`prod` (`rg-bccweb-shared` by default; read it
     from `terraform -chdir=iac/bootstrap output -json pre_created_rg_names`
     if unsure). `pr-preview.yml` reads `vars.SHARED_RG_NAME` directly to
     locate `swa-bccweb-shared` for both the `az staticwebapp secrets list`
     and `az staticwebapp environment delete` steps — without it those
     steps have no resource group to target.
   - `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_SUBSCRIPTION_ID` — the
     new preview identity's own OIDC secrets (`azure/login` reads these),
     never copied from `staging`.
   - `VITE_BLOB_BASE_URL` — same value as `staging`'s (previews build
     against staging's public data account); `pr-preview.yml` passes this
     straight through as a build-time env var.
   - The repository-level `PREVIEW_ENABLED` variable (see above) still
     applies regardless of which environment the job points at.
2. **Required-reviewer deployment protection.** Turn on GitHub's
   required-reviewer protection rule for that dedicated preview environment,
   so the credentials are only released to a workflow run after an approver
   signs off — closing the gap the same-repo check alone leaves for
   unreviewed branches from collaborators with write access.

Until both are in place, leave `PREVIEW_ENABLED` unset (or `false`); the
workflow is designed to skip cleanly so PR CI stays green either way.

## Phase 5.6 — Adopt any existing prod/shared tfstate

Per T1's per-environment container adoption, inventory the **old** shared
`tfstate` container before the first shared/prod apply against the new
per-env containers:

```sh
terraform -chdir=iac/shared init -reconfigure -backend-config=<old shared/common backend if one ever existed>
terraform -chdir=iac/shared state list
```

- **Empty or the backend never existed**: `shared` and `prod` are
  first-time provisions into their new `tfstate-shared`/`tfstate-prod`
  containers (phase 6 applies fresh — no adoption needed).
- **Non-empty** (unexpected — the app is not yet live, so this should not
  happen in practice): **STOP**. Do not blindly `terraform state push` a
  blob whose resources might belong to a different root — that would
  duplicate or destroy real resources when phase 6 applies. Instead,
  reconcile ownership explicitly per resource: `terraform import` each
  resource into the correct root's fresh state, or `terraform state rm`
  resources that don't belong and let the correct root's apply create/adopt
  them properly. This is the same no-blind-push discipline as
  `iac/bootstrap/README.md`'s "ADOPTION" section, applied to `iac/shared`
  and `iac/environment` (prod) instead of bootstrap itself.

The **no state-relocation subcommand** rule from phase 3 stays in force here
too — adoption means `import`/`state rm`, never the `mv` state-relocation
subcommand, and dev's state specifically is never adopted anywhere (dev is
destroyed, not migrated — phase 2).

## Phase 6 — Apply shared, then staging, then prod

Review and commit the non-secret, mode-0644
`iac/env/shared.generated.tfvars` written by phase 4 before applying (the
committed `iac/env/shared.tfvars` base already has `acs_email_domain` and
`acs_sender_address`). Its absence before the first bootstrap apply is
expected; shared cannot plan until the file is committed:

```sh
test -f iac/env/shared.generated.tfvars
git diff --no-index /dev/null iac/env/shared.generated.tfvars || test $? -eq 1

terraform -chdir=iac/shared init -backend-config=../env/shared.backend.hcl
terraform -chdir=iac/shared apply -var-file=../env/shared.tfvars -var-file=../env/shared.generated.tfvars
```

This provisions the Log Analytics workspace, per-env Application Insights,
Azure Communication Services, the Standard SWA, and (T23) the leaf-scoped
RBAC granting each app-env UMI Monitoring Reader / Contributor onto the
shared AI/ACS/SWA resources.

The first staging environment apply may leave `allowed_origins = []` in
`iac/env/staging.tfvars`. That bootstraps the stamp with **no Blob Storage CORS
rules** and is not browser-operational: the SPA cannot read Account B directly
from a different origin. After the shared apply above, obtain the Azure-assigned
hostname for its named staging environment:

```sh
STAGING_SPA_HOSTNAME=$(az staticwebapp environment show --name swa-bccweb-shared --resource-group <shared-rg> --environment-name staging --query hostname -o tsv)
```

That single Standard SWA serves the stable environment deployments and PR
preview environments; deploy automation links each environment's Function App
backend to it rather than provisioning an SWA per stamp. Set staging's committed
origin in both `app_url = "https://${STAGING_SPA_HOSTNAME}"` and
`allowed_origins = ["https://${STAGING_SPA_HOSTNAME}"]`, commit
`iac/env/staging.tfvars`, and re-apply `iac/environment` for staging before any
browser use. `app_url` becomes the Function App's public base for auth
verification/reset email links. Do not add a wildcard or treat the initial
empty-origin apply as a usable staging deployment.

```sh
terraform -chdir=iac/environment init -backend-config=../env/staging.backend.hcl
terraform -chdir=iac/environment apply -var-file=../env/staging.tfvars -var-file=../env/staging.local.tfvars -var 'terraform_principal_type=User'
```

Production is currently **undeployed**. Before running its first apply or deploy,
`www.advance-bcc.uk` must resolve to the shared SWA and be bound there as a custom
hostname, and the existing prod GitHub environment variable must be confirmed as
`WEB_HOST=www.advance-bcc.uk`; follow `docs/runbooks/dns-cutover.md`. Only after
those prerequisites are complete run:

```sh
terraform -chdir=iac/environment init -reconfigure -backend-config=../env/prod.backend.hcl
terraform -chdir=iac/environment apply -var-file=../env/prod.tfvars -var-file=../env/prod.local.tfvars -var 'terraform_principal_type=User'
```

That `prod` apply is a **first-time provision** in the refactored topology (per
phase 5.6's empty-inventory branch) — there is no prod teardown phase in
this runbook, and there must never be one: prod is the one environment this
migration creates rather than tears down and recreates.

If either apply hits a `403` writing Key Vault secrets on the very first
run, that's the documented RBAC-propagation lag (`iac/README.md`'s "First-time
Setup" step 7 note) — simply re-apply.

## Phase 7 — grep checklist: no stale `dev`/storage-name/blob-URL literals

Run this before considering the migration complete. Expect **zero** matches
for anything that isn't an intentional historical reference (e.g. this
runbook itself, or a comment explaining the two-account split):

```sh
rg -n "VITE_BLOB_BASE_URL|bccwebdev|\"dev\"" apps/web tests/e2e scripts
```

Dry run captured during authoring of this runbook (informational — re-run
live before cutover, this will drift as code changes):

```
apps/web/src/lib/blobClient.ts:7:   *   https://stbccwebprod.blob.core.windows.net/data
apps/web/src/AGENTS.md:  (public blob fetch) and `VITE_BLOB_BASE_URL` — dev proxies `/blob/*` → Azurite
apps/web/Dockerfile.dev: (filename only — "dev" here means "Docker Compose local dev", not the Azure dev environment; not a literal to change)
apps/web/package.json: "dev": "vite" (npm script name; not a literal to change)
```

None of these are stale `dev`-environment references — `blobClient.ts`'s
comment uses `stbccwebprod` as an illustrative example (matches the current
naming, pre-two-account-split comment; harmless docstring, not code), and
the `"dev"` hits are Docker/npm-script conventions unrelated to the retired
Azure `dev` environment. No `bccwebdev` literal exists anywhere in the
current tree (grep returned zero matches).

**Per-env web build variable matrix** (`VITE_BLOB_BASE_URL`, set at CI build
time per `deploy-app.yml`'s composite build step):

| Environment | `VITE_BLOB_BASE_URL` value |
|---|---|
| `staging` | `https://stbccwebstagingdata.blob.core.windows.net/data` |
| `prod` | `https://stbccwebproddata.blob.core.windows.net/data` |

Always **Account B** (`stbccweb<env>data`, the DATA account's public `data`
container) — never Account A (`stbccweb<env>rt`, the runtime account backing
`AzureWebJobsStorage` + the ten queues + the Flex deployment package).
`/api/*` calls remain a relative path (`api.ts`'s fetch wrapper), routed by
the SWA's linked backend — no `VITE_API_BASE_URL`-style variable exists or
is needed.

## Phase 8 — Post-cutover orphan sweep

Confirm dev leaves no trace anywhere in the subscription:

```sh
az resource list --query "[?contains(name, '-dev') || contains(name, 'bccwebdev')]" -o table
```

**Expect zero rows.** If any resource matches, it's an orphan from an
incomplete phase 2/3 teardown — investigate and remove it manually (check
its resource group first; it may be a leftover inside `stamp-dev` that the
phase-4 RG delete should have caught, or a resource created directly in
Azure outside Terraform's view).

Example failure-mode check (documented, not run against a live account
unless dev orphans are suspected):

```sh
# A mock az resource list JSON containing a `*bccwebdev*` entry:
echo '[{"name":"stbccwebdevdata"}]' | jq -e '[.[] | select(.name | test("-dev$|bccwebdev"))] | length == 0'
# exits 1 (non-zero) because the array is NOT empty — this is the failure
# signature the real sweep must never reproduce.
```

Worktree discipline: if you used `.worktrees/dev-teardown` in phase 2,
confirm it was removed (`git worktree list` should not show it) and its
branch/detached-HEAD reference cleaned up, per `AGENTS.md`'s "Plan Execution
(worktrees)" section.

## Summary of phase ordering (why this order, not another)

1. Back up state (0) so nothing is unrecoverable if a later phase goes wrong.
2. Pin the SHA (1) because `origin/main` becomes wrong the moment the
   refactor merges.
3. Destroy dev (2) from that pinned SHA — dev's real resources must be gone
   before the refactored bootstrap can safely drop dev from its map.
4. Pre-clean dev's tfstate footprint (3) so the tfstate-account lock never
   blocks the bootstrap apply that follows.
5. Apply the refactored bootstrap (4) — only now, because it deletes dev's
   already-empty RGs/UMI and creates the shared UMI other phases need.
6. Grant DNS (5) — only now, because it needs the shared UMI phase 4 just
   created.
7. Populate GitHub vars/secrets (5.5) and check for pre-existing state (5.6)
   — both must land before the shared/environment applies in phase 6 read
   them.
8. Apply shared → staging → prod (6), in that dependency order (environment
   reads shared's remote state).
9. Grep sweep (7) and orphan sweep (8) close out the migration.
