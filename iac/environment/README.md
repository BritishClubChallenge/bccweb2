# iac/environment — per-env application stack

The application infrastructure for one environment: a single stamp module
that consumes non-secret shared-resource IDs from the `iac/shared` remote
state. See [../README.md](../README.md) for the overall layout.

## Purpose

Composes one [`modules/stamp`](modules/stamp) child module containing the app's
runtime and data storage accounts, Function App, Key Vault (RBAC, 6 secrets),
and alert rules.
The shared root owns Application Insights, ACS, and the Static Web App. The
environment root reads `app_insights_ids`, `acs_id`, `acs_sender_address`, and
`env_umi_principal_ids` from shared state; Key Vault fetches both connection
strings directly from those resource IDs.

The stamp resource group is pre-created by
[`iac/bootstrap`](../bootstrap/README.md), which grants the environment's
Terraform UMI Owner on it. The module neither creates nor reads the resource
group.

## Backend

`../env/<env>.backend.hcl` (committed) — state key `<env>.tfstate` in the
bootstrap storage account. Bootstrap's `local_file.backend_config` writes to
this same authoritative path, so committed files and generated files agree —
always use `../env/<env>.backend.hcl`.

## tfvars

`../env/<env>.tfvars` is the committed, tracked, non-secret base — stamp
name, location, CORS origins, secret-version bumps, and the deterministic
topology (`stamp_rg_name`, `tfstate_resource_group_name`,
`tfstate_storage_account_name`), all committed because they're knowable once
`terraform_umis`/`github_environments` are fixed in `iac/bootstrap`. Only
secrets (`ops_email`, `puretrack_*`) live in a gitignored local overlay
copied from `../env/<env>.local.tfvars.example`. Local applies pass the base
file first and the local overlay second so the overlay wins, then append
`-var 'terraform_principal_type=User'` as a CLI override — that variable is
never committed in any tfvars file (see [../README.md](../README.md#first-time-setup) step 6).
CI loads the committed base with `-var-file`; `terraform-run.yml` maps only
the secrets explicitly into `TF_VAR_*` job environment entries (see
`.github/workflows/terraform-run.yml`). The shared-only
`iac/env/shared.generated.tfvars` is never loaded by environment plans.
Instead, `iac/shared` publishes its map as `env_umi_principal_ids`, and the
environment root selects the entry keyed by `stamp_name`.

## Required inputs

Every apply needs these values available through committed tfvars, shared remote
state, or local tfvars/GitHub Secrets as shown:

| Variable | Source | Notes |
|---|---|---|
| `stamp_name` | Committed base tfvars (`iac/env/<env>.tfvars`) | Environment name used as the resource-name suffix; authored, not CI-generated. |
| `stamp_rg_name` | Committed base tfvars (`iac/env/<env>.tfvars`) | Deterministic once `terraform_umis`/`github_environments` are fixed in bootstrap; not a GitHub variable. |
| `tfstate_resource_group_name` | Committed base tfvars (`iac/env/<env>.tfvars`) | Resource group containing the canonical state account; deterministic, not a GitHub variable. |
| `tfstate_storage_account_name` | Committed base tfvars (`iac/env/<env>.tfvars`) | Canonical state account containing `tfstate-shared/shared.tfstate`; deterministic, not a GitHub variable. |
| `operator_principal_id` | `iac/shared` remote-state output `env_umi_principal_ids[stamp_name]` | Object ID of the environment's GitHub OIDC/Terraform UMI. `iac/env/shared.generated.tfvars` is the single source of truth; per-environment tfvars do not duplicate it. It receives operator storage RBAC and is never the Function UMI client ID. |
| `ops_email` | tfvars locally / `secrets.TF_VAR_ops_email` in CI | Alert recipient; treated as a Secret, not a Variable, even though it isn't sensitive (public repo). |
| `puretrack_api_key`, `puretrack_email`, `puretrack_password` | `TF_VAR_*` secrets | Sensitive; never written to a tfvars file in CI. |

The ACS sender address is not an environment-root input; it comes from the
shared root's `acs_sender_address` remote-state output. Note:
`vars.TF_VAR_STAMP_RG_NAME` also exists as a bootstrap-published GitHub
environment variable, but it feeds `deploy-app.yml`'s application deploy
steps, not this Terraform root — this root's `stamp_rg_name` comes from the
committed tfvars, above.

Optional inputs (`allowed_origins`, `slack_webhook_url`, `jwt_secret_version`,
`acs_secret_version`, `blob_schema_mode`, `terraform_principal_type`) have defaults — see
[`variables.tf`](variables.tf) and `../env/<env>.tfvars.example`.

## Storage identity and RBAC

The stamp is secure-by-default and unconditionally uses managed identity with
`allowSharedKeyAccess=false` on both application storage accounts. The Function UMI is
the workload identity: it receives Storage Blob Data Owner, Storage Queue Data Contributor,
and Storage Table Data Contributor on the runtime account, plus Storage Blob Data Contributor
on the data account. Terraform configures Flex deployment with that UMI, the Functions host with
`AzureWebJobsStorage__accountName`/`__credential`/`__clientId`, and the API with
`RUNTIME_STORAGE_ACCOUNT_NAME`, `BLOB_STORAGE_ACCOUNT_NAME`, and
`STORAGE_UMI_CLIENT_ID`.

The required stamp-module `operator_principal_id` is a different identity: the environment's
GitHub OIDC/Terraform UMI used by deployment and remote operator scripts. The environment
root derives it from shared state via `env_umi_principal_ids[var.stamp_name]`. It receives
runtime Queue Contributor, data-account Blob Contributor, and `deploymentpackage`-scoped
Blob Contributor. Persistent grants do not go to local humans; a human using `az login`
needs a separate approved grant. Local/dev/Azurite continues to use
`AzureWebJobsStorage` and `BLOB_CONNECTION_STRING`.

Production is undeployed; when applied it will receive this same secure-by-default model.
Staging cutover is a single `terraform apply` through the manual `terraform.yml` workflow
or a local apply, followed by a redeploy. A brief staging interruption during cutover is
acceptable.

Rollback is a `git revert` of the secure-storage change, one re-apply, and a redeploy of
the prior artifact. `storage-rbac.tf` was added by this change, so the revert removes it
and destroys all seven role assignments; rolling forward again re-creates them, subject to
Azure RBAC propagation delay. No data or storage topology is removed. See
[../README.md](../README.md#staging-storage-cutover-and-rollback) for the full procedure
and the 403/propagation guidance.

**Precedence note**: `-var-file` values always override `TF_VAR_*`
environment variables for the same variable name, and a later `-var-file`
overrides an earlier one for the same variable. Passing both the committed
base and the local overlay (base first, overlay second) is the recommended
local path — see [../README.md](../README.md#first-time-setup) step 5.

## How to run

Apply (or re-apply) `iac/shared` before an environment apply so shared state publishes
the `env_umi_principal_ids` output. This ordering is required even when the identities
already exist, because the environment root consumes the map through remote state.

Preferred — via the manual workflow (uses the env's OIDC UMI). The
workflow's `env` input is a `[shared, staging, prod]` choice list (see
`.github/workflows/terraform.yml`) — adding another application environment
requires extending that choice list first (a workflow change, out of scope
here; see [../README.md](../README.md#adding-a-new-environment)):

```sh
gh workflow run terraform.yml -f env=staging -f action=plan
gh workflow run terraform.yml -f env=staging -f action=apply
# (or -f env=prod)
```

Locally (needs `az login` with rights on both resource groups; the CLI
override `-var 'terraform_principal_type=User'` is required for a human
principal — see [../README.md](../README.md#first-time-setup) step 6):

```sh
terraform -chdir=iac/environment init -backend-config=../env/<env>.backend.hcl
terraform -chdir=iac/environment apply -var-file=../env/<env>.tfvars -var-file=../env/<env>.local.tfvars -var 'terraform_principal_type=User'
```

## Outputs

The stamp module's outputs re-exported at the root are exactly
`resource_group_name`, `function_app_name`, `function_app_default_hostname`,
`storage_account_name_runtime`, `storage_account_name_data`,
`key_vault_name`, and `key_vault_uri`.

## ACS domain verification

ACS and its email domain are owned by the shared root. After applying that
root, print the DNS records ACS needs to verify the sending domain:

```sh
terraform -chdir=iac/shared output acs_dns_records_for_operator
```

The configured ACS email domain (`email.matt-ffffff.com`) is a **delegated
Azure DNS child zone** in resource group `rg-dns` — the registrar (GoDaddy)
holds only its four NS delegation records, never the ACS records themselves.
`domain_ownership`/`spf`/`dkim`/`dkim2` (and `dmarc`, an operator-authored
policy record ACS often omits — never publish a JSON `null`) must be
published there with `az network dns record-set`, using a name normalized
relative to the zone (raw names come back in different shapes per key — an
apex FQDN for some, an already-relative selector for others). The full
worked commands, the boundary-safe normalizer, and the DMARC fallback live
in `docs/runbooks/dns-cutover.md`'s "ACS email domain verification" section
— follow that runbook rather than duplicating it here.

Once Azure reports every check Verified, set `link_acs_email_domain = true`
in `iac/env/shared.tfvars` and re-apply the shared root to enable outbound
email. The shared root's output contract is documented in
[`../shared/OUTPUTS.md`](../shared/OUTPUTS.md).

**Sender-address propagation:** each environment root reads
`acs_sender_address` from shared state independently (see "Purpose" above),
so a shared apply that changes `acs_sender_address` does not by itself update
either Function App's `ACS_SENDER_ADDRESS`. After the shared apply, re-apply
**both** `staging` and `prod` to propagate the new value — domain linkage
(`link_acs_email_domain`) is a separate, later shared-only apply run only
after verification and needs no follow-up environment apply.

## Secret rotation

Key Vault secret copies are managed by Terraform. The stamp reads the shared
Application Insights component to obtain its connection string and calls
`listKeys` ephemerally on the shared ACS resource, so neither value crosses the
shared-state boundary. Bump `jwt_secret_version` or `acs_secret_version` and
re-apply to rotate those copies. See [../README.md](../README.md#secret-rotation).

## Tests

```sh
terraform -chdir=iac/environment test -test-directory=tests/unit          # mocked, offline

terraform -chdir=iac/environment init -backend-config=../env/<env>.backend.hcl
terraform -chdir=iac/environment test -test-directory=tests/integration   # plan-only, real subscription
```
