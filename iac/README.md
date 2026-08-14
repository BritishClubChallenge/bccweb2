# iac — Terraform Infrastructure

This directory manages the Azure resources for bccweb2 using a declarative,
three-root layout: `bootstrap/` (one-shot state backend + identities + resource
groups), `shared/` (the platform layer shared by `staging`/`prod`: Log Analytics,
per-env Application Insights, Azure Communication Services, and the Standard
Static Web App), and `environment/` (the per-environment application stamp).

All infrastructure is provisioned using **AzAPI v2.10** with HCL-native bodies.

## Layout

- `bootstrap/`: One-shot config provisioning the remote state storage account, the per-env Terraform UMIs (GitHub OIDC, RG-scoped Owner), the shared resource group plus one stamp resource group per application environment, and the GitHub environment secrets/variables. Uses **local state** (it provisions its own remote-state target, so it cannot live there itself). See [bootstrap/README.md](bootstrap/README.md).
- `shared/`: The platform layer used by the stable `staging`/`prod` environments — Sweden Central Log Analytics, per-environment Application Insights, and Azure Communication Services, plus one Standard-tier Static Web App in West Europe (the nearest supported SWA region, with production custom domain/DNS). One remote state, `shared.tfstate`. See [shared/README.md](shared/README.md).
- `environment/`: Per-env application stack, composed of a single `modules/stamp` child module (storage — two accounts, see below — Flex Consumption Function App, Key Vault, alerts, optional DNS). It reads only non-secret `app_insights_ids`/`acs_id`/`env_umi_principal_ids` from the `shared` root's remote state. One `terraform apply` provisions the stamp for a given environment. See [environment/README.md](environment/README.md).
- `env/`: Committed environment-specific configuration — `<env>.backend.hcl`, non-secret base values in `<env>.tfvars`, and bootstrap's non-secret `shared.generated.tfvars`. Secrets are supplied through explicit workflow `TF_VAR_*` environment mappings. The generated shared file is intentionally absent until bootstrap first applies, then must be reviewed and committed.

Bootstrap and the committed backend files use one canonical layout: storage
account `stbccweb13afe`, with one private `tfstate-<env>` container and one
`<env>.tfstate` blob per environment (including `tfstate-shared`).
`local_file.backend_config` writes the
same authoritative `iac/env/<env>.backend.hcl` path used by commands and
workflows. Every backend authenticates with Azure AD; shared-key access is
disabled on the account.

## State ownership

- **Bootstrap**: local state only, by design — it creates the storage account that everything else's remote state lives in.
- **Shared**: one remote state, `shared.tfstate`, in `tfstate-shared`. The shared UMI owns that container via Contributor; `staging`/`prod` receive Storage Blob Data Reader on it (read-only remote-state consumption).
- **Environment**: one remote state per environment, `<env>.tfstate`, in its own `tfstate-<env>` container in the storage account bootstrap creates. Each environment UMI has Storage Blob Data Contributor on only its own container. The documented `tf_tfstate_blob_account_reader` (does not exist / stale) account-wide grant was never present.

Bootstrap owns the shared resource group and every environment's stamp resource group. Downstream stacks never create or discover their own resource groups — they consume the names as plain Terraform inputs (`shared_rg_name`, `stamp_rg_name`). Both names are deterministic once `terraform_umis`/`github_environments` are fixed, so they're committed, non-secret values in `iac/env/{shared,staging,prod}.tfvars` — CI's Terraform applies read them straight from that `-var-file`, no GitHub variable involved. Bootstrap separately publishes `TF_VAR_STAMP_RG_NAME`/`SHARED_RG_NAME`/`AZURE_LOCATION` as GitHub Actions environment **variables** on `staging`/`prod`, but those feed `deploy-app.yml`'s `az` CLI steps (application deploy, not Terraform) — see the contract table below.

## Storage split (per environment)

Each environment's stamp has **two storage accounts** and a dual-mode application seam:

- **Account A** `stbccweb<env>rt` — runtime host storage, all ten queues, and the Flex
  Consumption `deploymentpackage` container. Local Azurite uses `AzureWebJobsStorage`;
  deployed Azure uses hierarchical managed-identity settings.
- **Account B** `stbccweb<env>data` — the `data` (public) and `data-private` containers.
  Local Azurite uses `BLOB_CONNECTION_STRING`; deployed Azure gives the API its explicit
  account name and Function UMI client ID.

The stamp module is secure-by-default: it unconditionally uses managed identity,
sets `allowSharedKeyAccess=false` on both application storage accounts, and grants
the required RBAC roles. There are no storage identity or Shared Key toggle variables.
The Function UMI is the workload identity for host, queue, deploymentpackage, and data
access. The required `operator_principal_id` is the per-environment GitHub OIDC/Terraform
UMI object ID for operator storage RBAC; it is never the Function UMI client ID. The
environment root derives it by selecting `var.stamp_name` from `iac/shared`'s
`env_umi_principal_ids` remote-state output, so `iac/env/shared.generated.tfvars` remains
the single source of truth rather than duplicating principal IDs in per-environment tfvars.

The operator UMI receives Storage Queue Data Contributor on the runtime account,
Storage Blob Data Contributor on the data account, and Storage Blob Data Contributor
scoped to `deploymentpackage`. The Function UMI receives Storage Blob Data Owner plus
Storage Queue Data Contributor and Storage Table Data Contributor on the runtime account,
and Storage Blob Data Contributor on the data account.

See [docs/architecture/storage-and-queues.md](../docs/architecture/storage-and-queues.md).

## First-time Setup

Follow these steps to provision the topology from scratch.

1.  **Authenticate**: Run `az login` to set the subscription context.
2.  **Bootstrap (human-run, one-shot)**:
    See [bootstrap/README.md](bootstrap/README.md) for detailed steps.
    `iac/bootstrap/terraform.tfvars` is the canonical, non-secret file and is
    already committed to this repo — only copy `terraform.tfvars.example`
    over it for a fork or a from-scratch subscription that needs different
    `tfstate_storage_account_name`/`terraform_umis` values:
    ```bash
    export GITHUB_TOKEN=<a token with Actions/Environments/Secrets: write>
    terraform -chdir=iac/bootstrap init -backend=false
    terraform -chdir=iac/bootstrap apply
    ```
    With the default `manage_github_secrets = true`, this apply creates each
    env's UMI, its resource group(s), its GitHub environment, the three
    Azure OIDC secrets (`AZURE_CLIENT_ID`/`AZURE_TENANT_ID`/`AZURE_SUBSCRIPTION_ID`),
    application deploy variables `TF_VAR_STAMP_RG_NAME`/`AZURE_LOCATION`/
    `SHARED_RG_NAME` on `staging`/`prod` (with `AZURE_LOCATION` sourced from
    the Sweden Central workload location; consumed by `deploy-app.yml`, and
    `SHARED_RG_NAME` also by `pr-preview.yml`; not Terraform). It also writes the complete UMI
    principal-ID map to `iac/env/shared.generated.tfvars` with mode 0644.
    That file is non-secret but cannot exist before bootstrap creates the
    identities; review and commit it after every bootstrap change. Everything
    else Terraform needs to know about the topology (`shared_rg_name`,
    `stamp_rg_name`, the `tfstate_*` values) is committed directly in
    `iac/env/{shared,staging,prod}.tfvars`.
    Without a `GITHUB_TOKEN`, set `manage_github_secrets = false` and wire
    those values into GitHub manually — see [bootstrap/README.md](bootstrap/README.md).
3.  **Review and commit bootstrap's generated shared inputs**:
    `iac/env/shared.tfvars` is the committed, tracked base — it already has
    the ACS email domain, `shared_rg_name`, and empty DNS placeholders filled
    in; don't re-copy the example over it. Bootstrap writes the principal IDs
    that do not exist before its first apply to the separate non-secret,
    mode-0644 `iac/env/shared.generated.tfvars`:
    ```bash
    test -f iac/env/shared.generated.tfvars
    git diff --no-index /dev/null iac/env/shared.generated.tfvars || test $? -eq 1
    git add iac/env/shared.generated.tfvars
    ```
    Review the exact identity map before committing it. Its absence is expected
    before the first bootstrap apply, but shared local and workflow plans cannot
    run until it exists in the checkout; ordinary PR contract tests do not run
    a shared remote plan and therefore do not require a fabricated placeholder.
    If your intended ACS email domain differs from the committed
    `acs_email_domain`/`acs_sender_address` in `iac/env/shared.tfvars`, edit
    that committed base file directly (the sender address domain must equal
    `acs_email_domain`). Leave the production hostname/DNS values empty
    until DNS cutover. There is no shared local overlay and no GitHub
    Terraform-variable fallback; see [shared/README.md](shared/README.md).
4.  **Apply the shared root**:
    ```bash
    terraform -chdir=iac/shared init -backend-config=../env/shared.backend.hcl
    terraform -chdir=iac/shared apply -var-file=../env/shared.tfvars -var-file=../env/shared.generated.tfvars
    ```
    This provisions the Log Analytics workspace, per-environment Application
    Insights, Azure Communication Services, and the Standard SWA, and publishes
    `env_umi_principal_ids`. Apply (or re-apply) this root before any environment
    apply so its remote state contains that output.
5.  **Prepare the environment root's local overlay**: the canonical backend
    file (`iac/env/<env>.backend.hcl`) is committed and may also be generated
    by bootstrap at that same path. `iac/env/staging.tfvars` is already the
    committed base — stamp name, location, required public auth-email origin
    (`app_url`), CORS origins, secret-version bumps, and the deterministic
    topology (`stamp_rg_name`,
    `tfstate_resource_group_name`, `tfstate_storage_account_name`). Only
    secrets (`ops_email`, `puretrack_*`, plus the optional Slack webhook)
    live in a gitignored local overlay. Copy its template and fill in the
    required placeholders:
    ```bash
    cp iac/env/staging.local.tfvars.example iac/env/staging.local.tfvars
    ```
    CI loads the committed base file with `-var-file` and supplies the same
    secrets through explicit `TF_VAR_*` job-environment mappings in
    `terraform-run.yml`; GitHub Secrets cannot be read back, so a local
    overlay is filled by hand.
6.  **Principal type**: `terraform_principal_type` defaults to
    `"ServicePrincipal"` because CI (GitHub Actions → per-env Terraform UMI
    via OIDC, see
    [bootstrap/README.md](bootstrap/README.md#github-actions-oidc-setup)) is
    the primary apply path. Local applies as yourself (`az login` as a
    user) MUST override to `"User"` — the Key Vault Secrets Officer role
    assignment (`keyvault.tf`) uses this to pick the correct
    `principalType`, and it will be wrong for a human principal otherwise.
    `terraform_principal_type` is **never committed** — not in
    `iac/env/<env>.tfvars` nor in `iac/env/<env>.local.tfvars.example` —
    so every local `iac/environment` apply/plan command in this document
    passes it as an explicit `-var 'terraform_principal_type=User'` CLI
    override after both `-var-file` flags. The shared root has no
    caller-scoped role assignment and needs no such override.
7.  **Deploy the environment stamp**:
    ```bash
    gh workflow run terraform.yml -f env=staging -f action=apply
    # or locally:
    terraform -chdir=iac/environment init -backend-config=../env/staging.backend.hcl
    terraform -chdir=iac/environment apply -var-file=../env/staging.tfvars -var-file=../env/staging.local.tfvars -var 'terraform_principal_type=User'
    ```
    This apply provisions the stamp module (storage — two accounts, Flex
    Consumption Function App, Key Vault, alerts) for the given environment,
    reading Application Insights and ACS identifiers plus the environment's
    operator principal ID from `iac/shared`'s remote state. The shared root must
    already have been applied with its `env_umi_principal_ids` output before this
    environment apply can succeed.

    Staging may be provisioned initially with `allowed_origins = []`; this emits
    no Blob Storage CORS rule and is therefore not ready for browser SPA use.
    Once the one shared SWA exists and its named staging environment has been
    deployed, read that environment's Azure-assigned hostname (not the shared
    production default hostname) with:
    ```bash
    az staticwebapp environment show --name swa-bccweb-shared --resource-group <shared-rg> --environment-name staging --query hostname -o tsv
    ```
    Commit `app_url = "https://<that-hostname>"` and
    `allowed_origins = ["https://<that-hostname>"]` to
    `iac/env/staging.tfvars`, and re-apply staging before using the SPA. The
    shared SWA serves stable environment deployments and PR previews while
    deploy automation maps each environment's Function App backend to it.

    `app_url` is required for every Azure environment and Terraform validates it
    as a canonical lowercase HTTPS origin before setting the Function App's
    `APP_URL`; auth verification/reset emails use that public origin. This HTTPS
    deployment contract does not make `APP_URL` mandatory for local development:
    the runtime helper falls back to `http://localhost:5173` when neither
    `APP_URL` nor `WEBSITE_HOSTNAME` is set.

    **Production remains undeployed.** Before its first apply/deploy,
    `www.advance-bcc.uk` must resolve to the shared SWA and be bound there as a
    custom hostname, and the existing prod GitHub environment variable must be
    `WEB_HOST=www.advance-bcc.uk`. Only then may the committed
    `app_url = "https://www.advance-bcc.uk"` be treated as reachable for auth
    email links and the production-domain smoke gate.

    After the shared apply, publish the DNS records printed by
    `terraform -chdir=iac/shared output acs_dns_records_for_operator` into the
    delegated Azure DNS child zone `email.matt-ffffff.com` (resource group
    `rg-dns`) — not at the registrar; GoDaddy only holds the NS delegation
    records for that subdomain — so Azure Communication Services can verify
    the email domain. See
    [dns-cutover.md](../docs/runbooks/dns-cutover.md#acs-email-domain-verification)
    for the exact `az network dns record-set` commands. Once Azure
    reports the domain verified, set `link_acs_email_domain = true` in the
    committed shared tfvars and re-apply — see
    [environment/README.md](environment/README.md#acs-domain-verification).
    If the shared apply also changed `acs_sender_address`, re-apply both
    `staging` and `prod` afterward so their Function Apps pick up the new
    `ACS_SENDER_ADDRESS`; domain linkage remains a separate, later shared-only
    apply run only after verification.

    **Note on RBAC Propagation**: On the very first apply, you might
    encounter a `403 Forbidden` error when writing secrets to Key Vault.
    This is caused by Azure RBAC propagation lag. Simply re-run the apply
    to resolve it.

## Staging storage cutover and rollback

The stamp is secure-by-default when applied. Production is undeployed; when applied, it
will receive the same managed-identity configuration with Shared Key disabled. Staging
cutover is one `terraform apply`, either through the manual `terraform.yml` workflow or
locally, followed by a redeploy of the application. A brief staging interruption during
the cutover is acceptable.

**A plain `git revert` of the secure-storage change is not a safe rollback.** It was
tested against this history and found dangerous: removing `storage-rbac.tf` and the
`azapi_update_resource` blocks in `storage.tf` stops Terraform from *managing*
`allowSharedKeyAccess`, but Azure does not reset the property to its prior value just
because nothing manages it any more — the account simply keeps its current value, which
is `false`. Meanwhile the reverted `functions.tf` restores `AzureWebJobsStorage` and
`BLOB_CONNECTION_STRING` as account-key connection strings and reverts the Flex
deployment to `type = "StorageAccountConnectionString"`. Applying that combination hands
the Function App key-based credentials against accounts that reject Shared Key — the
app cannot reach storage, and the deployment step that uploads the package over that
same connection string fails too.

The correct rollback is a **forward fix, not a revert**, and order matters:

1. Add an explicit `azapi_update_resource` (the same mechanism `storage.tf` already
   uses to disable Shared Key, since the parent `azapi_resource` body demonstrably does
   not reach Azure on its own) that sets `allowSharedKeyAccess = true` on both storage
   accounts, and apply it **before or together with** any change that hands the Function
   App key-based settings.
2. Only once both accounts accept Shared Key, restore the connection-string app settings
   and the `StorageAccountConnectionString` deployment type, and redeploy the prior
   artifact.
3. If rolling back the identity/RBAC portion too, `storage-rbac.tf` was added by that
   change, so removing it deletes the file and the next apply destroys all seven role
   assignments. Rolling forward again re-creates them and is subject to Azure RBAC
   propagation delay, same as the first apply.

**Application code never needs reverting.** The storage seams
(`apps/api/src/lib/storageClients.ts`, `scripts/lib/storageClients.mjs`,
`scripts/migrate/blobClient.mjs`) are dual-mode: they use a connection string when one is
configured and an account name plus managed identity otherwise. Rollback is purely an
infrastructure operation.

No data and no storage topology is removed by this rollback; the only thing the
RBAC-removal step above removes is the role assignments, which roll-forward restores. A
fresh role assignment can return 403 until Azure propagation completes; wait and retry
rather than weakening scopes.

## Secret Rotation

Secrets are managed declaratively. Rotating them means editing the version
variables in the committed base file, `iac/env/<env>.tfvars`, and re-applying
`iac/environment` — both locally and in CI, since CI loads the same committed
base with `-var-file`. There is no GitHub-variable alternative for these
values; they are authored, non-secret, and live only in the tracked tfvars.

-   **JWT Secret**: Bump `jwt_secret_version` (e.g., `"1"` → `"2"`). Terraform generates a new random password and updates Key Vault.
-   **ACS Connection String**: Rotate the access key in the Azure portal, then bump `acs_secret_version`. Terraform fetches the new key and updates Key Vault.
-   **App Insights Connection String**: This string does not rotate. It flows from the `iac/shared` root's Application Insights output into the stamp's Key Vault copy via a direct `data.azapi_resource` read — no ephemeral cross-stack secret ever crosses the state boundary.

## Adding a New Environment

To add a new application environment (e.g., a second `staging`-like env):

1.  Add a `terraform_umis` entry (+ the matching `github_environments` name) in `iac/bootstrap/terraform.tfvars` and re-apply bootstrap — this creates the env's UMI, its stamp resource group, its GitHub environment, the OIDC secrets, the application deploy variables (`TF_VAR_STAMP_RG_NAME`/`AZURE_LOCATION`/`SHARED_RG_NAME`) for `deploy-app.yml`, and regenerates `iac/env/shared.generated.tfvars` with the new UMI. Review and commit that generated file before planning shared.
2.  Select the new environment's string from the list-valued bootstrap output, then paste it into a committed `iac/env/<env>.backend.hcl`:
    ```bash
    env=<newenv>
    terraform -chdir=iac/bootstrap output -json backend_config_hcl |
      jq -er --arg env "$env" '.[] | select(contains("iac/env/\($env).backend.hcl"))'
    ```
    Also commit both a non-secret `iac/env/<env>.tfvars` base file — including
    the required canonical HTTPS auth-email origin (`app_url`), the deterministic
    topology (`stamp_rg_name`,
    `tfstate_resource_group_name`, `tfstate_storage_account_name`) that
    bootstrap's outputs make knowable up front — and an
    `iac/env/<env>.tfvars.example` full-schema reference, plus a gitignored
    `iac/env/<env>.local.tfvars.example` template documenting the
    secrets-only overlay for local applies.
3.  `terraform.yml`'s `env` input is a `[shared, staging, prod]` choice list (see `.github/workflows/terraform.yml`) — adding a fourth application environment requires extending that choice list (a workflow-file change). Until that lands, apply the new environment locally only:
    ```bash
    cp iac/env/<env>.local.tfvars.example iac/env/<env>.local.tfvars
    terraform -chdir=iac/environment init -backend-config=../env/<env>.backend.hcl
    terraform -chdir=iac/environment apply -var-file=../env/<env>.tfvars -var-file=../env/<env>.local.tfvars -var 'terraform_principal_type=User'
    ```

State is isolated per environment within the bootstrap storage account: each
`<env>.tfstate` blob lives in its own `tfstate-<env>` container. Each environment
UMI has Storage Blob Data Contributor only on that container, so it cannot read
or overwrite another environment's state. The old
`tf_tfstate_blob_account_reader` (does not exist / stale) account-level grant
was a documentation error, not a Terraform resource.

## GitHub Environment Variables & Secrets Contract

Each GitHub environment needs a specific set of secrets/variables: the OIDC
identifiers every root's Terraform apply needs, operator secrets Terraform
applies consume, and — for `staging`/`prod` — the application deploy variables
`deploy-app.yml` reads (`SHARED_RG_NAME` is also used by `pr-preview.yml`).
**Bootstrap-published**
entries are written automatically by `iac/bootstrap` (`manage_github_secrets
= true`); **operator-set** entries have no source of truth in Terraform and
must be added manually (repo Settings → Environments → `<env>` →
Variables/Secrets).

**Deterministic topology is committed tfvars, not a GitHub entry.** Every
value that's knowable once `terraform_umis`/`github_environments` are fixed
— `shared_rg_name`, `stamp_rg_name`, `tfstate_resource_group_name`,
`tfstate_storage_account_name`, plus every authored config value
(`production_hostname`, `dns_zone_name`, `dns_zone_resource_group_name`,
`app_url`, `allowed_origins`, `jwt_secret_version`, `acs_secret_version`,
`blob_schema_mode`, `acs_email_domain`, `acs_sender_address`) — lives only in
the committed base tfvars (`iac/env/<env>.tfvars`). Both local applies and CI
load that same file with `-var-file`; there is no GitHub-side duplicate to
keep in sync, and rotating one of these values (e.g. bumping
`jwt_secret_version`) means editing the base file and re-applying, not
touching GitHub. The bootstrap-created UMI object IDs live in the reviewed,
committed `iac/env/shared.generated.tfvars`; the shared root publishes that map
as `env_umi_principal_ids`, and each environment selects its own principal ID
from shared remote state. No per-environment tfvars or GitHub Actions variable
duplicates it.

| Name | Kind | Environments | Bootstrap-published or operator-set |
|---|---|---|---|
| `AZURE_CLIENT_ID`/`AZURE_TENANT_ID`/`AZURE_SUBSCRIPTION_ID` | Secret | all | Bootstrap-published (OIDC identifiers, not real secrets) |
| `TF_VAR_STAMP_RG_NAME` | Variable | `staging`, `prod` | Bootstrap-published (consumed by `deploy-app.yml`'s `az` CLI steps — **not** a Terraform input; `iac/environment`'s `stamp_rg_name` is committed in `iac/env/<env>.tfvars` instead) |
| `SHARED_RG_NAME` | Variable | `staging`, `prod` | Bootstrap-published (consumed by `deploy-app.yml`; Terraform's `shared_rg_name` is committed in `iac/env/shared.tfvars` instead) |
| `AZURE_LOCATION` | Variable | `staging`, `prod` | Bootstrap-published (consumed by `deploy-app.yml`; Terraform's `location` is committed in `iac/env/<env>.tfvars` instead) |
| `TF_VAR_ops_email` | **Secret** | `staging`, `prod` | Operator-set (public repo — kept as a Secret, not a Variable, even though it isn't sensitive) |
| `TF_VAR_puretrack_api_key`, `TF_VAR_puretrack_email`, `TF_VAR_puretrack_password` | Secret | `staging`, `prod` | Operator-set |
| `TF_VAR_slack_webhook_url` | Secret | `staging`, `prod` | Operator-set (optional, defaulted) |
| `AZURE_FUNCTIONAPP_NAME` | Variable | `staging`, `prod` | Operator-set |
| `VITE_BLOB_BASE_URL` | Variable | `staging`, `prod` | Operator-set |
| `WEB_HOST` | Variable | `prod` | Operator-set (production web hostname for the deploy-app.yml production-domain smoke; the existing value is `www.advance-bcc.uk` and must resolve to and be bound on the shared SWA before the currently undeployed production stamp is applied/deployed) |

Required-value validation is Terraform-native: `iac/shared` and
`iac/environment` variables carry `validation` blocks (e.g.
`shared_rg_name`, `stamp_rg_name`, `ops_email`, `puretrack_*`,
`env_umi_principal_ids`) that reject empty/whitespace values at plan time —
`terraform-run.yml` no longer runs a separate shell pre-check. For shared
plans, its explicit `-var-file=../env/shared.tfvars` is supplemented by
shared-only `TF_CLI_ARGS_plan=-var-file=../env/shared.generated.tfvars`;
Terraform resolves that relative path inside `iac/shared` because the command
uses `-chdir`. Environment plans receive an empty `TF_CLI_ARGS_plan` and load
only their committed target base. Applying `tfplan` uses the saved plan's
resolved variables and must not repeat either var-file.

## Tests

-   **Unit Tests**: Mocked provider tests that run quickly without Azure access.
    ```bash
    terraform -chdir=iac/environment test -test-directory=tests/unit
    ```
-   **Integration Tests**: Plan-only tests that run against a real subscription (requires `az login` and a backend init for the target environment).
    ```bash
    terraform -chdir=iac/environment init -backend-config=../env/<env>.backend.hcl
    terraform -chdir=iac/environment test -test-directory=tests/integration
    ```

## Provider Note

This project uses **AzAPI v2.10** for all resource management. The subscription ID is derived automatically from your active `az login` context (or the OIDC session in CI).
