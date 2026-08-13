# Production Cutover Runbook

This document is the official execution plan for transitioning the BCC competition management from the legacy .NET application to the bccweb2 platform.

Production is currently **undeployed**. Before any production Terraform apply or application deploy, `www.advance-bcc.uk` must resolve to the shared SWA and be bound there as a custom hostname, and the existing prod GitHub environment variable must be confirmed as `WEB_HOST=www.advance-bcc.uk`. The committed production `app_url = "https://www.advance-bcc.uk"` is the public base for auth verification/reset email links; do not treat it as reachable until those prerequisites pass.

## Pre-flight Checklist

The pre-flight phase ensures the destination environment is hardened, secrets are seeded, and legal requirements are met before any data migration starts. Every item in this checklist must be verified by the operator before proceeding to the dry-run.

1. **Verify Infrastructure State**: Run `terraform -chdir=iac/environment plan -var-file=../env/<env>.tfvars -var-file=../env/<env>.local.tfvars -var 'terraform_principal_type=User'` (local apply, committed base + local secrets overlay + the CLI principal-type override — see `iac/environment/README.md` § tfvars; drop the local overlay and the `-var` override when running via the `terraform.yml` CI workflow, which maps the equivalent secrets and defaults to `ServicePrincipal`) to ensure the environment stack is current. Ensure the plan shows zero changes and specifically verify that blob versioning is enabled, soft-delete retention is 7 days, and GRS replication is configured on the **data** storage account (the one holding `data`/`data-private`; the separate runtime/queue account is LRS-only by design). The management lock must be present on the data storage account to prevent accidental deletion during the cutover.

   Separately confirm the shared root shows zero drift: `terraform -chdir=iac/shared plan -var-file=../env/shared.tfvars -var-file=../env/shared.generated.tfvars` (this covers the Static Web App, ACS, and shared monitoring).
2. **Confirm Secret Seeding**: See `iac/README.md` § Secret rotation for the declarative KV seeding flow. Execute `az keyvault secret show --vault-name <key_vault_name> --name jwt-secret` to confirm the JWT secret was successfully seeded. The Function App will fail to start if this secret is missing.
3. **Legal Wording Check**: The Sign-to-Fly legal wording is admin-managed and versioned in the private blob `sign-to-fly/wording/active.json` (see `apps/api/src/lib/signTofly/wording.ts`, `manage/sign-to-fly/wording` API, and the `apps/web/src/pages/admin/SignToFlyWording.tsx` admin page) — there is no static `docs/legal/` file to diff. Ensure the currently-active wording version matches the text approved by the project owner in `.omo/evidence/legal/sign-to-fly-wording-approval.md`, using the admin wording page's version history to confirm. Any discrepancy here invalidates the legal integrity of the first round's signatures.
4. **Local Migration Workspace**: Create a clean `.migration-state/` directory on the migration machine. Ensure the machine has the latest `node` (v20+) and `sqlcmd` utilities installed and can connect to both the legacy SQL Server and the target Azure Storage Account.

## Dry-run

The dry-run simulates the full migration without making any mutable changes to the production storage containers.

Execute the migration script with the `--dry-run` flag — this validates/transforms the legacy data and persists its migration-state artifacts (all non-blob `.migration-state/` files, written on both `--dry-run` and full production runs, per `migrate.mjs`'s own comment at its `writeLegacyScoreManifest` call site): `id-map.json` (legacy-key → bccweb2-UUID mapping), `normalization-counts.json`, `discarded-counts.json`, and `legacy-score-manifest.json` (per-round legacy `PilotPoints`/`TeamScore`, read back by `validate.mjs` to prove migrated Complete rounds kept their exact legacy scores). No blobs are written in `--dry-run` mode. `migrate.mjs` does NOT itself write a reconciliation report — that is a separate step (see "Reconciliation" below):
```bash
node scripts/migrate/migrate.mjs --dry-run
```

Then generate the reconciliation report with `scripts/migrate/reconcile.mjs` (exact command in the "Reconciliation" section below). It reads three of those four artifacts — `id-map.json`, `normalization-counts.json`, and `discarded-counts.json` (confirmed: `readDiscardedCounts`/`readNormalizationCounts` imports plus the direct `MAP_PATH` read in `reconcile.mjs`) — and writes `.migration-state/reconciliation-report.json`. It does NOT read `legacy-score-manifest.json`; that file is read separately by `validate.mjs` (`readLegacyScoreManifest`) to verify migrated Complete rounds kept their exact legacy `PilotPoints`/`TeamScore` (see the "Validation" section below). That report has no "orphans" section — verify these two fields instead, per its actual schema (`scripts/migrate/reconcile.mjs`):
- `report.perEntity` — `{ <entity>: { count, sample } }` for every `entity:` prefix found in the id-map keys (e.g. `pilot`, `round`, `club`, `site`). Compare each `count` against the legacy database's row count for that entity.
- `report.anomalies` — an array of `{ type, message }`. The base run (no `--against-prod-snapshot`) can emit `duplicate_uuid` (the same UUID value reused across different id-map keys) or `malformed_key` (an id-map key missing its `entity:` prefix); running with `--against-prod-snapshot <path>` additionally compares expected vs. actual per-entity counts and can also emit `count_mismatch` for any entity that disagrees (see "Reconciliation" below). `reconcile.mjs` exits 1 and logs `Anomalies detected: <n>` when this array is non-empty, or logs `No anomalies detected.` and exits 0 when empty — treat exit code 0 / an empty `anomalies` array as the pass condition, not any legacy-status-normalization claim.

Finally, run the privacy scanner against the dry-run output (if exported to a local Azurite instance) with `BLOB_CONNECTION_STRING="UseDevelopmentStorage=true" node scripts/migrate/validate.mjs` — it has no CLI flags; `BLOB_CONNECTION_STRING` wins when set (the Azurite dev-storage shorthand shown here, or a connection string against a Shared-Key-enabled account), otherwise it falls back to `BLOB_STORAGE_ACCOUNT_NAME` + the invoking identity's `DefaultAzureCredential` (see the "Validation" section below for that remote form). The scanner must return a clean pass (exit code 0) to ensure no PII (emails, phone numbers, medical info) is leaked into the public `data` container.

## Reconciliation

Reconciliation is the process of proving that the migrated data is byte-compatible with the source of truth and conforms to the bccweb2 status state machine. This phase bridges the gap between the dry-run and the full migration.

Compare the `id-map.json` generated during the dry-run with the legacy SQL IDs. Every id-map value must be a UUID unique to its legacy key. Use the `scripts/migrate/reconcile.mjs` utility to produce the reconciliation report; pass `--against-prod-snapshot <path>` to also compare against a captured production dry-run snapshot (adds `report.prodRows`/`report.stdoutExpectedCounts`, each entity's expected vs. actual count, and a `count_mismatch` anomaly per entity that disagrees) instead of just the default id-map-only checks.

```bash
node scripts/migrate/reconcile.mjs
```


Two independent checks gate sign-off, per `reconcile.mjs`'s actual report fields (see the "Dry-run" section above): the top-level `anomalies` array must be empty (equivalently, `reconcile.mjs` exits 0 and logs "No anomalies detected."); and separately, review `report.normalizationCounts.normalization.roundStatus` (`{ passthrough, rewritten, unmapped }`, written by `migrate.mjs`'s enum-normalization tally, `scripts/migrate/enum-normalize.mjs`). **`unmapped` is NOT purely an error count** — `normalizeEnum()` increments it both for a truly unrecognized legacy status AND for any legacy status whose alias intentionally maps to `null` (today: `inactive → null`, so `unmapped` normally includes every legacy round with status `Inactive`, which `normalizeRoundStatus(raw) ?? "Proposed"` then relabels to `"Proposed"` by design — see `ROUND_STATUS_ALIASES` in that file). There is no zero-`unmapped` threshold to enforce and no fixed "acceptable" count to invent. Instead: compare this run's `normalizationCounts.normalization.roundStatus` against the counts from a prior/approved dry-run (or against the known distinct status values present in the legacy database), and investigate only genuinely unexpected movement — e.g. an `unmapped` total larger than "known Inactive rounds + previously-seen unmapped values" indicates a NEW, unrecognized legacy status that needs triage (add it to `ROUND_STATUS_ALIASES`, or confirm the "Proposed" default is acceptable for it). The `anomalies` array remains the independent, unconditional pass/fail signal for sign-off; `normalizationCounts` is a review-and-compare artifact, not a second pass/fail gate with its own numeric threshold. Sign-off for this phase is granted only when the reconciliation report is attached to the cutover record.

## Full migration

The full migration is the point of no return for the data transition. It writes all entities to the production `data` and `data-private` containers. This must be performed during a scheduled maintenance window while the legacy app is in read-only mode.

1. **Legacy Read-Only**: Disable write access to the legacy SQL database or set the legacy app to "Maintenance Mode" at the load balancer.
2. **Execute Migration**:
   ```bash
   PRODUCTION_CONFIRM=YES node scripts/migrate/migrate.mjs --force-production
   ```
3. **Verify Write Success**: Monitor the logs for any 403 (Authentication) or 409 (Conflict) errors. The script uses idempotent UUIDs from `id-map.json`, so it can be resumed with `--resume` if interrupted.

Once `migrate.mjs` completes, it has written its migration-state artifacts (`id-map.json`, `normalization-counts.json`, `discarded-counts.json`, `legacy-score-manifest.json` — see "Dry-run" above for what each holds) but it does NOT itself write a reconciliation report. Run `scripts/migrate/reconcile.mjs` separately against this production run to generate `.migration-state/reconciliation-report.json`. That report is the primary evidence for the "Migration idempotency + reconciliation" row in the Sign-off Matrix. Do not proceed to DNS cutover until it shows an empty `anomalies` array and the `normalizationCounts` review below finds nothing unexpected (per the "Reconciliation" section above).

## Validation

Validation ensures the newly written blobs are accessible by the API and correctly formatted for the SPA. This phase runs before the public DNS is switched, against the already-provisioned production storage account and Function App.

Run the production validation:
```bash
# Verify public blob accessibility and PII redaction (no CLI flags. Target
# resolution: BLOB_CONNECTION_STRING wins when set; otherwise
# BLOB_STORAGE_ACCOUNT_NAME + the invoking identity's DefaultAzureCredential.
# Storage stamps are secure by default with Shared Key disabled, so use the
# identity form below against stbccwebproddata: run `az login` first — this
# requires a separately approved data-plane role grant for your account;
# persistent remote access belongs to the environment's GitHub OIDC/Terraform
# UMI, not a human's standing permissions — or rely on CI's OIDC identity.
# make build first, since this validator imports @bccweb/schemas from its
# built dist/):
BLOB_STORAGE_ACCOUNT_NAME="stbccwebproddata" \
  node scripts/migrate/validate.mjs

# Local/Azurite form (still fully supported — this is how developers run it):
BLOB_CONNECTION_STRING="UseDevelopmentStorage=true" \
  node scripts/migrate/validate.mjs

# Smoke-check the deployed API the same way deploy-prod.yml's post-deploy
# gate does (docs/runbooks/deploy-smoke-failure.md):
curl -fsS "https://<function_app_name>.azurewebsites.net/api/health"
curl -fsS "https://<function_app_name>.azurewebsites.net/api/seasons" | jq -e 'type == "array" and length > 0'

# For a fuller pilot/coordinator journey check against the live production
# host before DNS cutover, point Playwright's E2E_BASE_URL at it (see
# tests/e2e/playwright.config.ts and `npm run e2e`):
E2E_BASE_URL="https://<production-swa-hostname>" npm run e2e
```

Ensure the Application Insights dashboard shows no 5xx errors during these tests. Check the `exceptions` table in Kusto for any `StatusNormalizationError` or `BlobLeaseError`. Validation is complete when the privacy scanner returns a clean pass and both the `/api/health` and `/api/seasons` smoke checks above return HTTP `200`; the `/api/seasons` check is the same non-empty-array gate as `deploy-prod.yml` (`type == "array" and length > 0`), while the `curl -fsS` calls assert HTTP success (`-f` fails the command on a non-2xx status). There is no separate response-time acceptance threshold for this validation phase; performance/latency gates (p95 < 2,000 ms, p99 < 5,000 ms per cohort) are the `sign` load-test's criteria, covered separately in `docs/runbooks/load-testing.md`, not this cutover validation step.

## Smoke test

The smoke test is a high-level walkthrough of the critical pilot and coordinator journeys. This is the final manual gate before public traffic is admitted to the platform.

1. **Sign-in Flow**: Use a test pilot account to sign in. Verify the 401 auto-refresh logic works by manually deleting the access token from localStorage and clicking a protected link.
2. **Sign-to-Fly Flow**: Navigate to a "BriefComplete" round. Verify the legal wording is rendered correctly. Click "Accept" and verify that a new record is created in the `signatures/` private container.
3. **Coordinator Lock**: As an admin, lock a round. Verify that the `PilotSnapshot` is created and that the round status transitions to "Locked".

Capture screenshots of these three successful journeys and save them to `.omo/evidence/cutover-smoke/`. These screenshots serve as the "Evidence Path" for the "Application Insights + alert rules" and "Auth integration suite" sign-off rows.

## DNS cutover

DNS cutover moves public traffic from the legacy hostname to the new bccweb2 Azure Static Web App and ACS email domain. This phase requires access to the domain registrar and Azure Portal.

The detailed runbook (TTL strategy, SPF/DKIM/DMARC verification, manual-vs-Terraform CNAME path, validation script, rollback) lives at `docs/runbooks/dns-cutover.md`. The short version:

1. **ACS Email Domain**: Publish the lowercase operator records provided by `terraform -chdir=iac/shared output acs_dns_records_for_operator` (`domain_ownership`, `spf`, `dkim`, `dkim2`, each carrying Azure's `type`, `name`, and `value` — and `dmarc`, an operator-authored deliverability record ACS often returns as `null` rather than an ACS-verified value) into the delegated Azure DNS child zone `email.matt-ffffff.com` (resource group `rg-dns`) — GoDaddy only holds the NS delegation for that subdomain, so these records never go at the registrar; see `docs/runbooks/dns-cutover.md` for the exact `az network dns record-set` commands, including the name-normalization helper and the `dmarc`-is-`null` fallback. Publish DMARC with `p=none` for first cutover — tighten after one clean week. Confirm verification in the Azure Portal, then set `link_acs_email_domain = true` in the committed shared tfvars and run the reviewed shared Terraform apply before treating outbound mail as enabled. If `acs_sender_address` changed, also apply `staging` and `prod` afterward so `ACS_SENDER_ADDRESS` propagates to both Function Apps (see `docs/runbooks/dns-cutover.md`).
2. **CNAME Update**: Derive the SWA default host from `terraform -chdir=iac/shared output -raw swa_default_hostname`. There is one Static Web App shared across the whole topology (`swa-bccweb-shared`), so it is not created per environment. When both `production_hostname` and `dns_zone_name` are set, Terraform owns the CNAME via `iac/shared/dns.tf`; follow the managed path in `docs/runbooks/dns-cutover.md`. Otherwise, update the registrar and use `swa_default_hostname` as the target.
3. **TTL Strategy**: 24h before cutover lower TTL to 300s; flip target at 300s; raise back to 3600s 24h after stable traffic. See `docs/runbooks/dns-cutover.md` for the full schedule.
4. **Validation**: run `PROD_HOST=... SWA_HOST=... API_HOST=... ACS_EMAIL_DOMAIN=... bash scripts/iac/validate-dns.sh` and capture the output to `.omo/evidence/task-51-dns.txt`.

Monitor the SWA metrics for the first 15 minutes. Ensure the `2xx` count increases and `4xx`/`5xx` counts remain at baseline. If the CNAME update results in a SSL/TLS handshake error, verify that the SWA custom domain has successfully validated the certificate.

## Rollback window

The rollback window is the period during which the team commits to maintaining the ability to revert to the legacy system with zero data loss. Per User Decision #7, this window is **7 days**.

During this 7-day window:
- The legacy SQL database must remain online in read-only mode (to serve as a reference).
- No blobs in the Azure storage account may be permanently deleted: blob versioning is enabled and soft-delete retention is configured at 7 days on the data storage account (`iac/environment/modules/stamp/storage.tf`) — this alone covers the window since old blob versions/deletes are recoverable, but do not manually purge or reduce these settings during the 7-day window.
- The `_current` symlink on the legacy server (if applicable) must point to a backup of the legacy binaries.

At the end of the 7 days, if no critical "Rollback" level incidents are open, the decommission phase may begin. If a rollback is triggered, the window is reset once the issue is resolved and a new cutover date is set.

## Decommission

Decommissioning involves the permanent removal of legacy infrastructure and the formal closure of the migration project. This occurs only after the 7-day rollback window has elapsed without incident. See `docs/runbooks/decommission.md` for the full post-window decommission plan.

1. **Legacy App Shutdown**: Stop the IIS site or App Service hosting the legacy .NET application.
2. **Database Archive**: Perform a final backup of the legacy SQL database and move the `.bak` file to long-term cold storage (e.g., Azure Archive Tier).
3. **Infrastructure Cleanup**: Decommission any legacy-specific infrastructure (the legacy .NET App Service / IIS host, its SQL Server, and any legacy-only networking) directly in the Azure Portal or via `az` CLI against the **legacy** resource group. **Never** run `terraform destroy` against `iac/environment` here — that stack is bccweb2's own production infrastructure (Function App, SWA, storage, Key Vault), not the legacy system, and destroying it would take down the platform this runbook just cut traffic over to.

Formal sign-off for decommissioning is required from the project owner (Matt White). This sign-off confirms that the new platform is stable, all historical data is safely archived, and the legacy system is no longer incurring costs or security risks.

## Sign-off Matrix

| Blocker | Owner Name | Sign-off Date (YYYY-MM-DD) | Evidence Path | Status (pending/signed-off) |
|---|---|---|---|---|
| Sign-to-Fly wording approval | - | - | `.omo/evidence/legal/sign-to-fly-wording-approval.md` | pending |
| PII removal verified | - | - | `.omo/evidence/task-22-clean-pass.txt` + `task-21-no-pii-public.txt` | pending |
| Storage hardening (versioning, soft-delete, GRS, mgmt lock) | - | - | `.omo/evidence/task-6-iac-plan-assertions.txt` | pending |
| JWT_SECRET + ACS in Key Vault | - | - | `.omo/evidence/task-7-kv-ref-in-plan.txt` | pending |
| Migration idempotency + reconciliation | - | - | `.omo/evidence/task-8-idempotent-dryrun.txt` + `task-43-migration-smoke.txt` | pending |
| ACS email domain DNS verification | - | - | `.omo/evidence/task-51-dns.txt` + `.omo/evidence/task-51-mail-score.txt` (see `docs/runbooks/dns-cutover.md`) | pending |
| Application Insights + alert rules | - | - | TBD by T46+T47 | pending |
| Post-deploy smoke gate in CI | - | - | TBD by T48 | pending |
| Auth integration suite + round lifecycle suite green | - | - | `.omo/evidence/task-41-auth-suite.txt` + `task-42-lifecycle-suite.txt` | pending |
| Scoring regression suite green | - | - | `.omo/evidence/task-44-scoring-regression.txt` | pending |
| Production dry-run + reconciliation report zero anomalies | - | - | TBD by T50 | pending |

## Communication plan

A successful cutover requires clear communication with all stakeholders (pilots, club coordinators, and admins) to manage expectations and minimize support overhead.

### Pre-cutover Announcement (Email Template)
**Subject**: Important: BCC Website Migration - Maintenance Window
**Body**:
Hi Pilots,
We are moving to the new BCC management platform (bccweb2) on [DATE].
Between [TIME_START] and [TIME_END], the website will be in maintenance mode. 
**Action Required**: After the cutover, you will need to sign in and accept the updated 2026 Terms & Conditions before signing to fly in your next round.
The new site is mobile-optimised and includes improved round registration and safety briefing flows.

### Maintenance Page Text
"The BCC website is currently undergoing a scheduled upgrade to the bccweb2 platform. We expect to be back online by [TIME_END]. Thank you for your patience."

**Note**: there is no built-in maintenance-mode page or reference image in this repo yet — the SPA has no maintenance component and `apps/web/public` has no `assets/` directory. Publish this text via whatever hosting-level mechanism is available at cutover time (e.g. a temporary static page swapped in ahead of the SWA deploy, or a banner at the registrar/CDN layer) until a maintenance-mode feature ships.

### Post-cutover All-Clear Message
"The migration to bccweb2 is complete. All systems are green. Pilots can now sign in at www.advance-bcc.uk to update their profiles and register for upcoming rounds."

## Rollback plan

The rollback plan provides a guaranteed path back to the legacy system if the bccweb2 platform fails in production. It must be executable within 1 hour.

### 1. Revert DNS
Immediately point the primary CNAME back to the legacy host:
```bash
# Verify current state
dig www.advance-bcc.uk CNAME

# At registrar: Change www.advance-bcc.uk from <SWA_HOST> to <LEGACY_HOST>
# (e.g. bcc-legacy.flyparagliding.org.uk)
```

### 2. Restore Storage State
If data corruption occurred in the Azure containers, use the versioning/soft-delete features to restore:
```bash
# List versions of a corrupted blob
az storage blob version list --container data --name rounds.json --output table

# Restore the version prior to cutover
az storage blob copy start \
  --source-uri "https://<storage>.blob.core.windows.net/data/rounds.json?versionId=<OLD_VERSION>" \
  --destination-blob rounds.json \
  --destination-container data
```

### 3. Re-enable Legacy App
Switch the legacy application from read-only/maintenance mode back to active.
- Re-enable SQL write permissions for the legacy app user.
- Start the IIS site on the legacy server.
- Verify connectivity to the legacy database via `curl -I http://bcc-legacy.flyparagliding.org.uk`.
