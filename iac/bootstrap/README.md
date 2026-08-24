# iac/bootstrap — Terraform remote state bootstrap

One-shot Terraform config that provisions the Azure resources backing the
**remote state** and the **CI identities** for the `iac/environment/` stack:

- Bootstrap resource group
- Storage account (StorageV2 + LRS, public blob access disabled, TLS 1.2)
- Blob service with 30-day soft-delete + container soft-delete
- Per-environment `tfstate-<env>` blob containers (private)
- `CanNotDelete` management lock on the storage account
- One **shared resource group** (`rg-bccweb-shared`) plus one `stamp-<env>`
  resource group per application environment; downstream stacks consume the
  names as inputs and never create or discover their own resource groups
- **Per-stack Terraform UMIs** with RG-scoped Owner, GitHub OIDC
  federation, and per-env GitHub Actions secrets **and variables** (see
  "Populate GitHub secrets" below)

Everything is provisioned via **AzAPI v2.10** with HCL-native bodies (no
JSON-encoded body strings). This config uses **local state** intentionally; see
"Why local state?" below.

---

## When to run

- **First time, once per Azure subscription/region**, before the first
  `terraform apply` in `iac/shared` or `iac/environment`. The first apply
  creates `iac/env/shared.generated.tfvars`; review and commit that file before
  running shared.
- **Re-run whenever the per-environment set changes**: adding a new
  environment (new `terraform_umis` entry + matching `github_environments`
  name — see "Adding a new GitHub environment" below), or backfilling the
  `TF_VAR_STAMP_RG_NAME`/`AZURE_LOCATION`/`SHARED_RG_NAME` deploy variables
  for an environment bootstrapped before that publication existed (see
  "Populate GitHub secrets" below). Before every re-apply, save and review a
  plan. Publishing the missing deploy variables is the required outcome for
  an existing environment, but it may not be the only change: the current
  bootstrap configuration can also reconcile `allowSharedKeyAccess = false`
  and any other pending drift recorded in the plan — including, on an
  environment bootstrapped before the deterministic-topology-as-committed-tfvars
  change, **deletes** of the now-retired GitHub variables
  `TF_VAR_shared_rg_name`, `TF_VAR_tfstate_resource_group_name`, and
  `TF_VAR_tfstate_storage_account_name` (bootstrap no longer publishes these;
  the topology they carried is deterministic and lives in the committed
  `iac/env/{shared,staging,prod}.tfvars` instead — see "Populate GitHub
  secrets" below). Confirm the committed tfvars/backend files already match
  bootstrap's new plan before accepting those deletions; the values must not
  disappear from both places at once.
- Also re-run if you need to recreate the bootstrap RG or rotate to a
  different storage account (a rarer, destructive operation — see "Safe
  re-apply / teardown" below).

One bootstrap storage account hosts a tfstate blob container per environment
(`tfstate-staging`, `tfstate-prod`, and `tfstate-shared`, each holding an
environment-specific tfstate blob) —
there is no separate container per stack, since the platform and stamp
modules now apply together in one state per environment.

## Prerequisites

- Terraform ≥ 1.11.
- `az login` against a principal with **Owner** (or **Contributor** +
  **User Access Administrator**) on the target subscription — this config
  creates `Microsoft.Authorization/roleAssignments` resources (`tf_owner_role`,
  `tf_tfstate_blob_role`, and `tf_tfstate_shared_reader` in `main.tf`) to grant
  each UMI Owner on exactly its shared or stamp RG and Storage Blob Data
  Contributor on its own state container, plus each application UMI Reader on
  `tfstate-shared`. The previously
  documented `tf_tfstate_blob_account_reader` (does not exist / stale) resource
  was never present; plain **Contributor** alone does NOT include
  `Microsoft.Authorization/roleAssignments/write` and the apply will fail with
  an authorization error on those resources.
- A globally-unique storage account name (3–24 chars, lowercase letters and
  digits only — see `variables.tf`).
- `export GITHUB_TOKEN=<token>` — a GitHub fine-grained PAT with
  Repository permissions **Actions: write**, **Environments: write**, and
  **Secrets: write** on `BritishClubChallenge/bccweb2` (or a classic PAT with the
  `repo` scope). Required only for bootstrap apply when
  `manage_github_secrets = true` (the default). The PAT is **not** used by
  the runtime Function App or by any CI workflow — it only authenticates
  the `integrations/github` provider during this one-shot apply. If you
  cannot supply a token, set `manage_github_secrets = false` and the
  github provider will never be invoked (see "Escape hatch" below).

## How to run

```sh
# 1. Initialise (no backend — local state by design).
terraform -chdir=iac/bootstrap init -backend=false

# 2. Validate.
terraform -chdir=iac/bootstrap validate

# 3. `iac/bootstrap/terraform.tfvars` is the canonical, non-secret file and
#    is committed to this repo — there is nothing to copy for the normal
#    case. `terraform.tfvars.example` stays alongside it as a template only
#    for a fork or a from-scratch subscription that needs different
#    `tfstate_storage_account_name`/`terraform_umis` values; in that case,
#    copy the example and edit it before the first apply:
#    cp iac/bootstrap/terraform.tfvars.example iac/bootstrap/terraform.tfvars

# 4. Apply. Other variables have sensible defaults (location=swedencentral,
#    bootstrap_rg_name=rg-bccweb-tfstate, tfstate_container_prefix=tfstate).
terraform -chdir=iac/bootstrap apply

# 5. Review and commit the generated, non-secret shared input (mode 0644).
test -f iac/env/shared.generated.tfvars
git diff --no-index /dev/null iac/env/shared.generated.tfvars || test $? -eq 1

# 6. Display every backend config snippet. The output is a list of strings.
terraform -chdir=iac/bootstrap output -json backend_config_hcl | jq -r '.[]'
```

`iac/env/shared.generated.tfvars` is intentionally absent before the first
bootstrap apply because the UMI principal IDs do not exist yet. A shared
workflow plan cannot run until the reviewed file is committed; do not create a
placeholder. Environment plans never consume this file.

## Copying outputs into `iac/env/<env>.backend.hcl`

The `backend_config_hcl` output is a list of ready-to-paste strings, one entry
per `github_environments` value. Select the entry for a new environment
`<env>` (for example `staging`) by its generated-file comment:

```sh
env=staging
terraform -chdir=iac/bootstrap output -json backend_config_hcl |
  jq -er --arg env "$env" '.[] | select(contains("iac/env/\($env).backend.hcl"))'
```

Paste the `<env>` entry you need into a committed `iac/env/<env>.backend.hcl`
with `key = "<env>.tfstate"`, then initialise the environment stack against
it:

```sh
terraform -chdir=iac/environment init -backend-config=../env/prod.backend.hcl
```

`iac/environment` sets `backend "azurerm" {}` (empty); all of its backend
config is supplied at `init` time from this file. There is only one backend
file per environment now — the platform and stamp modules apply together in
a single state, so there is no separate `common-<env>.backend.hcl`.

The committed files and `local_file.backend_config` now share the authoritative
`iac/env/<env>.backend.hcl` path and resolve to the live bootstrap-managed
account. Do not substitute the obsolete root-level `iac/<env>.backend.hcl`
files for these configs.

## ADOPTION: migrate existing state without losing history

Adopt the per-environment containers only in a reviewed maintenance window.
The canonical account is the account already managed by the local bootstrap
state; never change `tfstate_storage_account_name` to make configuration match
an old backend file because that would propose replacement of the locked,
in-use account. Never delete or overwrite the only copy of `prod.tfstate`.

1. Confirm the live account and preserve the bootstrap state before changing
   remote state:
   ```sh
   terraform -chdir=iac/bootstrap state show azapi_resource.tfstate_sa
   mkdir -p .terraform-state-backup
   cp iac/bootstrap/terraform.tfstate .terraform-state-backup/bootstrap.tfstate
   ```
2. Inventory the old and destination blobs, then download every existing state
   blob with Azure AD authentication. Repeat the download for each environment
   and for any destination blob that already exists; keep the directory outside
   version control:
   ```sh
   az storage blob list --auth-mode login --account-name <old-account> --container-name <old-container> -o table
   az storage blob download --auth-mode login --account-name <old-account> --container-name <old-container> --name prod.tfstate --file .terraform-state-backup/prod.source.tfstate
   az storage blob download --auth-mode login --account-name stbccweb13afe --container-name tfstate-prod --name prod.tfstate --file .terraform-state-backup/prod.destination.tfstate
   ```
   A missing destination blob is expected on first adoption; a missing source
   blob is a stop condition.
3. Reconcile the local bootstrap state before any bootstrap apply. If a live
   account or per-environment container exists but is absent from
   `terraform state list`, import it rather than recreating it:
   ```sh
   terraform -chdir=iac/bootstrap import azapi_resource.tfstate_sa /subscriptions/<subscription-id>/resourceGroups/rg-bccweb-tfstate/providers/Microsoft.Storage/storageAccounts/stbccweb13afe
   terraform -chdir=iac/bootstrap import 'azapi_resource.tfstate_container["prod"]' /subscriptions/<subscription-id>/resourceGroups/rg-bccweb-tfstate/providers/Microsoft.Storage/storageAccounts/stbccweb13afe/blobServices/default/containers/tfstate-prod
   ```
   Import only missing addresses. Save and review a bootstrap plan before an
   operator applies it to create missing containers and container-scoped role
   assignments.
4. Pull each source backend through Terraform, preserving another byte-for-byte
   backup, then initialize the canonical destination and push that exact state:
   ```sh
   terraform -chdir=iac/environment init -reconfigure -backend-config=<source-backend.hcl>
   terraform -chdir=iac/environment state pull > .terraform-state-backup/prod.pulled.tfstate
   terraform -chdir=iac/environment init -reconfigure -backend-config=../env/prod.backend.hcl
   terraform -chdir=iac/environment state push .terraform-state-backup/prod.pulled.tfstate
   terraform -chdir=iac/environment state pull > .terraform-state-backup/prod.after.tfstate
   ```
5. Compare the pulled state serial, lineage, and resource addresses before and
   after the push, then run a refresh-only plan against the canonical backend.
   Retain all backups and the old `prod.tfstate` blob until every environment
   has passed review; adoption copies history and does not delete the source.

## Outputs

| Output | Description |
|---|---|
| `resource_group_name` | Name of the bootstrap RG holding the tfstate SA. |
| `storage_account_name` | Name of the storage account hosting tfstate blobs. |
| `container_name` | List of tfstate blob-container names, one per environment. Display with `terraform -chdir=iac/bootstrap output -json container_name | jq -r '.[]'`. |
| `backend_config_hcl` | List of copy-pasteable HCL strings for `iac/env/<env>.backend.hcl`, one per `github_environments` value; select one with the JSON/JQ procedure above. |
| `terraform_umi_client_ids` | Map env → app (client) ID of that env's Terraform UMI. Pass as `AZURE_CLIENT_ID` to `azure/login@v3`. Not secrets — OIDC binds each to its federated subject. |
| `terraform_umi_principal_ids` | Map env → object (principal) ID of that env's Terraform UMI. Bootstrap also writes this map to the non-secret, mode-0644 `iac/env/shared.generated.tfvars`; review and commit that file for downstream RBAC. |
| `terraform_umi_resource_ids` | Map env → full Azure resource ID of that env's Terraform UMI. |
| `pre_created_rg_names` | Map `shared`/`stamp-<env>` → RG name; bootstrap publishes the relevant names as GitHub environment variables. |
| `pre_created_rg_ids` | Map `shared`/`stamp-<env>` → RG Azure resource ID. |
| `tenant_id` | Azure AD tenant ID. Pass as `AZURE_TENANT_ID`. |
| `subscription_id` | Azure subscription ID. Pass as `AZURE_SUBSCRIPTION_ID`. |
| `github_actions_setup` | Operator runbook (multi-line), including the two published RG-name variables. Run `terraform -chdir=iac/bootstrap output -raw github_actions_setup` to print. |
| `github_environments_created` | List of GitHub environment names Terraform created/adopted (empty when `manage_github_secrets = false`). |

## GitHub Actions OIDC setup

Before applying Azure federated credentials for an existing repository, enable
GitHub's immutable subject and verify the exact repository prefix:

```sh
gh api --method PUT repos/BritishClubChallenge/bccweb2/actions/oidc/customization/sub \
  -F use_default=true \
  -F use_immutable_subject=true
gh api repos/BritishClubChallenge/bccweb2/actions/oidc/customization/sub
```

The response must report `use_immutable_subject: true` and the
`repo:BritishClubChallenge@318211912/bccweb2@1264013182` prefix committed as
`github_oidc_subject_repo`. The GitHub provider does not manage this repository
setting, so this opt-in is an explicit bootstrap prerequisite.

The bootstrap provisions **one user-assigned managed identity (UMI) per
downstream stack** (`id-bccweb-terraform-staging`,
`id-bccweb-terraform-prod`, `id-bccweb-terraform-shared`) that GitHub Actions
assumes via OIDC — no client secrets stored anywhere. Each UMI carries exactly
one federated identity credential, scoped to
`repo:<github_oidc_subject_repo>:environment:<github_env>` per its
`terraform_umis` entry. The canonical input includes GitHub's immutable owner
and repository IDs so Azure exactly matches the subject GitHub emits.

**Security note**: Each UMI is granted **RG-scoped Owner** on exactly one
pre-created resource group — never at subscription scope:

- `id-bccweb-terraform-staging` → Owner on `stamp-staging`
- `id-bccweb-terraform-prod` → Owner on `stamp-prod`
- `id-bccweb-terraform-shared` → Owner on `rg-bccweb-shared`

plus **Storage Blob Data Contributor** on its own tfstate container (the
azurerm backend uses Azure AD auth). The staging and prod identities additionally
receive **Storage Blob Data Reader** on `tfstate-shared`, allowing remote-state
output reads without write/delete access. The RG-scoped Owner grants prevent a
staging pipeline from changing prod workload resources, and the container-scoped
Contributor grant prevents it from reading or overwriting prod state. The former
`tf_tfstate_blob_account_reader` (does not exist / stale) account-level Reader
claim was documentation-only. Restrict who can edit `terraform_umis` and
`github_repo` — adding an entry grants that GitHub environment Owner over its
named RG via OIDC and contributor access to its named tfstate container.

### Adding a new GitHub environment

Add a `terraform_umis` entry and the matching `github_environments` name in
`iac/bootstrap/terraform.tfvars`, then re-apply:

```hcl
# iac/bootstrap/terraform.tfvars
github_environments = ["staging", "prod", "shared", "preview"]

terraform_umis = {
  # ... existing staging + prod + shared entries ...
  preview = {
    stamp_rg   = "stamp-preview"
    github_env = "preview"
  }
}
```

```sh
terraform -chdir=iac/bootstrap apply
```

The apply creates the env's UMI, federated credential, stamp RG, role
assignments, GitHub environment, and secrets in one shot. The federated
subject claim is `repo:<owner@id/repo@id>:environment:<name>`, using the
canonical `github_oidc_subject_repo` input, so the
`github_env` value and the GitHub environment name must match exactly
(case-sensitive).

**`preview` above is a generic name for this walkthrough, not the dedicated
PR-preview identity `.github/workflows/pr-preview.yml` needs.** This recipe
grants the new UMI **RG-scoped Owner** over a brand-new `stamp-preview`
resource group — exactly the kind of broad grant the PR-preview identity
must NOT have (see
[`docs/runbooks/migration-shared-topology.md`](../../docs/runbooks/migration-shared-topology.md#preview-environment-security-preconditions-required-before-preview_enabledtrue)).
The real PR-preview identity only needs to manage SWA preview slots on the
existing shared `swa-bccweb-shared` resource — it wants no `stamp_rg` at
all. Bootstrap's `terraform_umis` map has no way to express that narrower
grant (it only issues RG-scoped Owner over a freshly created stamp RG per
entry), so that identity, its role assignment, and its GitHub environment
must be created out-of-band (`az identity create` + a scoped `az role
assignment create` for SWA management, then a GitHub environment wired to
its OIDC federated credential manually) rather than through this
`terraform_umis` recipe. Once that dedicated environment exists, it also
needs its own environment-scoped `SHARED_RG_NAME` variable set by hand
(bootstrap only auto-publishes `SHARED_RG_NAME` to `staging`/`prod`,
because only those two appear in `terraform_umis`) — see the migration
runbook section linked above for the full checklist.

### Populate GitHub secrets

When `manage_github_secrets = true` (the default), **Terraform creates the
GitHub environments and pushes the three Azure identifiers as
environment-scoped Actions secrets plus the application deploy variables for
you** —
no manual paste is required. Deterministic topology (`shared_rg_name`,
`stamp_rg_name`, `tfstate_resource_group_name`, `tfstate_storage_account_name`)
is **not** part of this publication — it's committed directly in
`iac/env/{shared,staging,prod}.tfvars` (see below) and bootstrap never writes
a GitHub variable for it. The `integrations/github` provider
authenticates via the `GITHUB_TOKEN` environment variable (see
Prerequisites). After `terraform -chdir=iac/bootstrap apply` completes,
verify in the GitHub UI at:

```
https://github.com/<owner/repo>/settings/environments/<env>
```

Each environment receives the following secrets — note `AZURE_CLIENT_ID`
**differs per environment** (each env trusts only its own UMI):

| Secret | Source | Per-env? |
|---|---|---|
| `AZURE_CLIENT_ID` | `azapi_resource.tf_umi["<env>"].output.properties.clientId` | **Yes — different value per env** |
| `AZURE_TENANT_ID` | `data.azapi_client_config.current.tenant_id` | No (shared) |
| `AZURE_SUBSCRIPTION_ID` | `data.azapi_client_config.current.subscription_id` | No (shared) |

Application environments receive these GitHub Actions **variables** (not
secrets) so `deploy-app.yml`'s `az` CLI steps never have to hand-supply
bootstrap-owned topology. These are **application deploy variables, not
Terraform inputs** — `iac/environment`'s and `iac/shared`'s own
`stamp_rg_name`/`shared_rg_name`/`tfstate_*` variables are deterministic once
`terraform_umis`/`github_environments` are fixed, so they're committed
directly in `iac/env/{shared,staging,prod}.tfvars` instead:

| Variable | Source | Per-env? |
|---|---|---|
| `TF_VAR_STAMP_RG_NAME` | `azapi_resource.pre_created_rg["stamp-<env>"].name` | **Yes — different RG name per env** |
| `SHARED_RG_NAME` | `azapi_resource.pre_created_rg["shared"].name` | `staging` and `prod` both, immediately on apply |
| `AZURE_LOCATION` | `var.location` (`swedencentral` by default) | `staging` and `prod` both, immediately on apply |

No GitHub Actions variable is a Terraform input. Bootstrap writes the complete
env-to-principal-ID map (including `shared`) to the non-secret, mode-0644
`iac/env/shared.generated.tfvars` instead. Review and commit it after apply;
the identities do not exist soon enough to commit it before the first apply.

None of these are real secrets — `clientId` is bound to the federated
subject by OIDC (so even disclosed it cannot be used outside the
permitted GitHub repo+environment), and `tenantId`/`subscriptionId` are
just routing identifiers. Terraform still delivers them via the
`github_actions_environment_secret.azure` resource's `value` attribute
(the GitHub Actions secrets API, transported over TLS) rather than the
plain `github_actions_environment_variable` resource, because the GitHub
API only accepts environment-scoped `AZURE_CLIENT_ID`/`AZURE_TENANT_ID`/
`AZURE_SUBSCRIPTION_ID` through the secrets endpoint. Because bootstrap
uses **local** state (see "Why local state?" below), these plain values —
not the topology variables, which use the separate `github_actions_environment_variable`
resource below and never touch the secrets endpoint — land in this
config's local `terraform.tfstate` unencrypted; that is acceptable only
because none of them are real secrets, per the paragraph above.

If a `prod` or `staging` GitHub environment already exists with
operator-configured protection (required reviewers, admin bypass disabled,
self-review prevention, or a wait timer), import it into bootstrap state
**before the first bootstrap apply**:

```sh
terraform -chdir=iac/bootstrap import 'github_repository_environment.envs["<env>"]' <owner>/<repo>:<env>
```

This import is mandatory for safe adoption. Creating the Terraform resource is
an upsert that can overwrite a pre-existing remote environment with provider
defaults; `lifecycle.ignore_changes` cannot protect it on that first apply.
After import, `ignore_changes` keeps the UI-owned required reviewers, deployment
branch policy, wait timer, admin-bypass setting, and self-review prevention
stable on subsequent applies.

**Re-applying against an environment bootstrapped before this variable
publication existed**: `terraform_umis` entries created before
`TF_VAR_STAMP_RG_NAME`/`AZURE_LOCATION`/`SHARED_RG_NAME` were added may
already have their GitHub environment in bootstrap state, but that environment
won't have the variables yet. Run and review
`terraform -chdir=iac/bootstrap plan` against the same `terraform.tfvars`, then
apply the reviewed plan to backfill them. If the remote environment is not in
bootstrap state, import it first as described above. The published variables
are the required outcome, not a guarantee that they are the sole changes: the
plan may also reconcile
`allowSharedKeyAccess = false` or other pending bootstrap drift.

**Deleting the retired deterministic-topology GitHub variables**: an
environment bootstrapped before the deterministic topology moved to committed
tfvars may still carry the older, now-unmanaged GitHub variables
`TF_VAR_shared_rg_name`, `TF_VAR_tfstate_resource_group_name`, and
`TF_VAR_tfstate_storage_account_name` — bootstrap's current configuration no
longer declares these, so the very next `terraform -chdir=iac/bootstrap plan`
against that environment will propose **deleting** them. That's expected and
correct: their values now live only in the committed
`iac/env/{shared,staging,prod}.tfvars` and `iac/env/<env>.backend.hcl` files.
Before an operator accepts a plan containing these deletes, verify the
committed tfvars and backend files for every affected environment already
carry the equivalent, correct values (`shared_rg_name`, `stamp_rg_name`,
`tfstate_resource_group_name`, `tfstate_storage_account_name` in
`iac/env/<env>.tfvars`, and the matching `resource_group_name`/
`storage_account_name`/`container_name` in `iac/env/<env>.backend.hcl`) — if
they don't, fix the committed files first, then re-run the plan and accept
the deletes only once the committed source of truth matches. Accepting the
deletes without that check would drop the values from both places at once.

#### Escape hatch: `manage_github_secrets = false`

If you cannot supply a `GITHUB_TOKEN` (or want to manage the secrets out of
band), set:

```hcl
# iac/bootstrap/terraform.tfvars
manage_github_secrets = false
```

Or pass `-var 'manage_github_secrets=false'` on the command line. With this
flag, neither `github_repository_environment`,
`github_actions_environment_secret`, nor `github_actions_environment_variable`
is created — every `for_each` in that group evaluates to an empty set/map and
the github provider is never invoked. You still get the UMIs + federated
credentials + RG-scoped Owner grants; just print the identifiers from the
outputs and paste them manually:

```sh
terraform -chdir=iac/bootstrap output -json terraform_umi_client_ids
terraform -chdir=iac/bootstrap output -raw tenant_id
terraform -chdir=iac/bootstrap output -raw subscription_id
terraform -chdir=iac/bootstrap output -json pre_created_rg_names
```

Add the first three as **environment-level** secrets (repo-level cannot
work — each environment needs its own clientId) and the applicable values as
environment-level **variables**. The complete resolved list is available in
the `github_actions_setup` output:

| Secret | Value |
|---|---|
| `AZURE_CLIENT_ID` | `terraform_umi_client_ids["<env>"]` output (per env) |
| `AZURE_TENANT_ID` | `tenant_id` output |
| `AZURE_SUBSCRIPTION_ID` | `subscription_id` output |

| Variable | Value |
|---|---|
| `TF_VAR_STAMP_RG_NAME` | `pre_created_rg_names["stamp-<env>"]` output (per env) |
| `SHARED_RG_NAME` | `pre_created_rg_names["shared"]` output (staging, prod) |
| `AZURE_LOCATION` | `location` variable value (staging, prod) |

### Workflow requirements

Every job that runs `az` / Terraform must:

```yaml
permissions:
  id-token: write   # required for OIDC token issuance
  contents: read

jobs:
  apply:
    runs-on: ubuntu-latest
    environment: prod   # must match a federated env name
    steps:
      - uses: azure/login@v3
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
```

Without `environment: <name>`, GitHub issues an OIDC token whose `sub` claim
uses a branch context instead of the configured immutable
`repo:<owner@id/repo@id>:environment:<name>` form, which no
federated credential here trusts — `azure/login` will fail with a 400. The
`environment` also selects which env-scoped `AZURE_CLIENT_ID` the job reads,
binding the job to that env's UMI and its RG-scoped permissions.

Print the full operator runbook (including the resolved client-id, tenant-id,
subscription-id, and the list of currently-federated environments):

```sh
terraform -chdir=iac/bootstrap output -raw github_actions_setup
```

## Why local state?

This configuration provisions its own remote-state target — it cannot itself
live in that target without a chicken-and-egg problem on the very first apply.
Local state for the bootstrap is the standard pattern:

- `iac/bootstrap/terraform.tfstate` is committed-free (gitignored). Lose it and
  you re-import or `terraform import` the resources this config declares
  (`main.tf`) — the fixed RG/SA/blob-service/lock set plus one entry per
  environment for the tfstate container, UMI, federated credential, and role
  assignments. None require destructive recreation to recover — every AzAPI
  resource here is idempotent and importable by its Azure resource ID.
- The `CanNotDelete` lock on the storage account protects against accidental
  destroy from any source, including a bootstrap re-apply after a state loss.
- All downstream state (`iac/environment` per environment and the shared
  stack) lives remotely in the SA this config creates.

## Safe re-apply / teardown

- Re-running with the same inputs is idempotent, but not guaranteed to be a
  no-op when deployed resources or state differ from the current
  configuration. Always save and review a plan before re-applying; in
  particular, current state may need to reconcile
  `allowSharedKeyAccess = false` alongside RG-variable publication.
- To destroy: first remove the `azapi_resource.tfstate_sa_lock` resource via
  Terraform (or `az lock delete`), then `terraform destroy`. **Doing so will
  irrecoverably delete every remote tfstate blob** — coordinate carefully.

## Guardrails

- No AzureRM provider resources or data sources are used. AzAPI only.
- No JSON-encoded bodies — all HCL-native objects.
- The bootstrap RG, storage account, blob service, and management lock are
  single-instance — no `for_each` / `count`. The tfstate blob **container**
  is per-environment (`azapi_resource.tfstate_container`, `for_each =
  var.github_environments`, named `<tfstate_container_prefix>-<env>`, e.g.
  `tfstate-staging`) — one container per environment inside the single storage
  account, not one shared container. Fan-out (`for_each`) is also used for
  UMIs, federated credentials, pre-created RGs, and role assignments keyed by
  `terraform_umis`; the RG map has one shared entry plus one stamp entry per
  application environment.
- No subscription- or storage-account-scoped role assignments — only
  RG-scoped Owner, per-container Storage Blob Data Contributor on each UMI's
  own container, and application-UMI Reader on `tfstate-shared`.
