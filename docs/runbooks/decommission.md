# Legacy Decommission Runbook

This runbook documents the procedure for decommissioning the legacy .NET application and its associated infrastructure. This process occurs only after the mandatory 7-day rollback window has elapsed and the bccweb2 platform is confirmed stable.

## Rollback window

The rollback window is the 7-day period following the production cutover during which the legacy application remains fully operational to facilitate an immediate revert if critical issues are discovered in the new platform.

- **Duration**: 7 days (as per User Decision #7).
- **Start**: The moment the primary DNS CNAME is switched to the bccweb2 environment.
- **Legacy State**: The legacy application must stay running at a backup hostname (see "Legacy hostname" section) in **read-only mode**. 
- **Read-Only Enforcement**: Disable write permissions for the legacy application's SQL user or enable the legacy app's internal "Maintenance/Read-Only" toggle.
- **Purpose**: Provides a safety net allowing the team to point DNS back to the legacy system with zero data loss, as no new data is written to the legacy database during this window.

## Legacy hostname

During the rollback window, the legacy application is accessible via a secondary hostname to allow side-by-side verification and data spot-checks.

- **Backup Hostname**: `legacy.bcc.org.uk` (or similar pattern as configured at the registrar).
- **Configuration**: 
  1. Create a CNAME or A record for `legacy.bcc.org.uk` pointing to the legacy IIS/App Service host.
  2. Update the legacy application's web configuration (e.g., `web.config` or App Service bindings) to accept traffic from this hostname.
  3. Ensure the SSL/TLS certificate covers the legacy hostname (e.g., via a wildcard `*.bcc.org.uk` or a specific SAN).
- **Verification**:
  ```bash
  # Verify legacy hostname resolves correctly
  dig legacy.bcc.org.uk +short
  
  # Verify legacy app is reachable and identifies as legacy
  curl -I https://legacy.bcc.org.uk | grep -i "X-Legacy-App"
  ```

## Day 0-7 monitoring

Before decommissioning, the following stability signals must be confirmed for 7 consecutive days:

1. **Zero Critical Incidents**: No "Severity 1" or "Severity 2" bugs open against bccweb2.
2. **Clean Telemetry**: Application Insights shows zero 5xx errors or unhandled exceptions related to core flows (Auth, Round Registration, Scoring).
3. **Zero Traffic on Legacy**: Monitor the legacy IIS/App Service logs. Safe decommission requires near-zero traffic on the `legacy.bcc.org.uk` hostname, indicating all users have successfully transitioned.
4. **Data Parity**: No reported discrepancies between the migrated data and the legacy source of truth that require the legacy app to remain live for investigation.

## SQL backup

A final, immutable snapshot of the legacy SQL database must be exported and retained for historical and legal audit purposes.

- **Procedure**: Use `sqlpackage` or the Azure Portal to export a BACPAC file.
  ```bash
  # Example using sqlpackage (standard for Azure SQL)
  sqlpackage /a:Export \
    /ssn:tcp:bcc-legacy.database.windows.net,1433 \
    /sdn:bcc_legacy_db \
    /su:migration_admin \
    /sp:SecretPassword123 \
    /tf:bccweb-legacy-final-$(date +%Y-%m-%d).bacpac
  ```
- **Retention**: Minimum 1 year (per project policy).
- **Storage Location**: Store the BACPAC in a dedicated Azure Storage account with **Archive Tier** enabled for cost efficiency. The container must have a management lock.
- **Encryption**: Verify "Encryption at Rest" is enabled on the target storage account (default for Azure Storage).
- **Verification**:
  ```bash
  # Verify the exported file is not corrupt by checking the header
  sqlpackage /a:Extract /tf:bccweb-legacy-final-$(date +%Y-%m-%d).bacpac /tsn:(localdb)\mssqllocaldb /tdn:TestImport
  ```

## Decommission day procedure

Follow these steps in sequence on the scheduled decommission day.

### 1. Final Monitoring Snapshot
Capture a final Application Insights dashboard screenshot and export the last 7 days of the `exceptions` and `requests` logs to `.omo/evidence/ops/decommission-pre-check-{date}.json`.

### 2. Redirect Legacy Hostname
Configure a permanent redirect (301) from `legacy.bcc.org.uk` to the primary bccweb2 hostname (`www.advance-bcc.uk`). This can be done via the registrar's redirect service or a small static site.
```bash
# Verify redirect
curl -I https://legacy.bcc.org.uk
# Expected: HTTP/1.1 301 Moved Permanently
# Location: https://www.advance-bcc.uk/
```

### 3. Final SQL Export
Perform the BACPAC export as documented in the "SQL backup" section. Upload the file to the archive storage account.
```bash
az storage blob upload \
  --account-name bccarchive \
  --container legacy-backups \
  --file bccweb-legacy-final-$(date +%Y-%m-%d).bacpac \
  --name final-snapshot.bacpac \
  --tier Archive
```

### 4. Target Infrastructure Destroy
Use `terraform destroy` with explicit `-target` flags against the **legacy** infrastructure
only. **NEVER** run a blanket destroy.
```bash
# Example targeted destroy commands
terraform destroy \
  -target=azurerm_linux_web_app.legacy_app \
  -target=azurerm_mssql_database.legacy_db \
  -target=azurerm_mssql_server.legacy_server \
  -target=azurerm_dns_cname_record.legacy_hostname
```

If this decommission ever needs to tear down bccweb2's OWN three-root Terraform topology
(e.g. a full project shutdown, not just the legacy app), the order is strict and the
reverse of how the roots were built: **env-stamp (`iac/environment`) → shared
(`iac/shared`) → bootstrap (`iac/bootstrap`)**. The shared root's monitoring, ACS, and SWA
resources carry `prevent_destroy` in Terraform (lifecycle-level protection); the
env-stamp's prod data storage account carries no `prevent_destroy` at all — it is
protected only by an Azure `CanNotDelete` management lock (management-plane, not
Terraform). **Lift both before attempting destroy**:

```bash
# 1. Remove the management lock on the prod data storage account first —
#    `terraform destroy` cannot remove a locked resource.
az lock delete --name storage-nodelete \
  --resource-group "$(terraform -chdir=iac/environment output -raw resource_group_name)" \
  --resource-name "$(terraform -chdir=iac/environment output -raw storage_account_name_data)" \
  --resource-type Microsoft.Storage/storageAccounts

# 2. Remove `prevent_destroy = true` from the affected resources
#    (iac/shared/monitoring.tf, iac/shared/acs.tf, iac/shared/swa.tf for the
#    shared root — the env-stamp's prod data storage account has no
#    `prevent_destroy`; the lock removed in step 1 is its only protection)
#    and commit that change before running destroy.

# 3. Destroy in order: env-stamp for every application environment first,
#    then shared, then bootstrap last (bootstrap owns the tfstate storage
#    account and RGs that the other two roots' state depends on).
terraform -chdir=iac/environment destroy -var-file=../env/<env>.tfvars -var-file=../env/<env>.local.tfvars
terraform -chdir=iac/shared destroy -var-file=../env/shared.tfvars -var-file=../env/shared.generated.tfvars
terraform -chdir=iac/bootstrap destroy
```

Destroying out of order (e.g. bootstrap before env-stamp) orphans the other roots' state —
their backend containers and RG live in bootstrap, and shared's monitoring/ACS/SWA outputs
are consumed by every env-stamp's remote-state read.

### 5. Remove `_current` Symlink
On the legacy deployment server (if applicable), remove the `_current` symlink pointing to the legacy binaries. This is a deliberate, separate step to prevent accidental restarts of the old code.
```bash
ssh deploy@legacy-server "rm /var/www/bcc-legacy/_current"
```

### 6. Archive Evidence
Create the completion evidence file at `.omo/evidence/ops/decommission-complete-{date}.md` documenting the results of steps 1-5.

## Named-owner sign-off matrix

The decommissioning is complete only when all rows in this table are signed off by the named owner.

| Step | Owner Name | Sign-off Date | Status |
|---|---|---|---|
| 7-day monitoring period clean | Matt White | - | unsigned |
| Final SQL BACPAC verified | - | - | unsigned |
| Legacy resources destroyed (-target) | - | - | unsigned |
| `_current` symlink removed | - | - | unsigned |
| Retention policy (1yr) documented | Matt White | - | unsigned |

## Rollback window guarantees

If a **CRITICAL** bug is found during the 7-day rollback window:
1. **Immediate DNS Revert**: Follow `docs/runbooks/dns-cutover.md` to point the primary CNAME back to the legacy host.
2. **Legacy Restoration**: The legacy app immediately serves traffic. Since it was in read-only mode, it is in a known-good state.
3. **Data Preservation**: No data is lost from the legacy system. Any data entered into bccweb2 during the failure window must be manually reconciled if the outage lasts more than 1 hour.
4. **Incident Resolution**: The bccweb2 team resolves the critical bug and performs a new cutover dry-run before scheduling a new cutover date.

## Communication plan

### 1-Week Notice (Pilots)
**Subject**: BCC Legacy Site Decommissioning
**Body**: "Hi Pilots, as bccweb2 has been stable for the first week of operations, the legacy 'legacy.bcc.org.uk' hostname will be decommissioned on [DATE]. All historical results remain available on the new platform."

### Post-Decommission All-Clear (Internal Team)
**Subject**: [OPS] Legacy Decommission Complete
**Body**: "The legacy .NET application and SQL database have been decommissioned. A final BACPAC backup is stored in the archive tier (retention: 1 year). The bccweb2 project transition is formally closed."
