# DNS Cutover Runbook (T51)

This runbook covers two intertwined DNS changes that ship together at production cutover:

1. **ACS email domain verification and activation** — publish SPF, DKIM, DKIM2 and DMARC records at the registrar, wait for Azure verification, then enable the committed domain-link toggle so outbound mail is deliverable.
2. **Production CNAME flip** — point the public hostname (e.g. `bcc.flyparagliding.org.uk`) at the Azure Static Web App default hostname.

The two changes are independent in DNS but conventionally done in the same operator session. The TTL strategy below applies to both.

> **Record-name handling:** `iac/shared/dns.tf` correctly computes the Azure DNS
> zone-relative record name with `trimsuffix(var.production_hostname,
> ".${var.dns_zone_name}")`. For example, `www.example.com` under zone `example.com`
> becomes `www`. As a cutover safeguard, review `terraform -chdir=iac/shared plan -var-file=../env/shared.tfvars -var-file=../env/shared.generated.tfvars`
> before applying and confirm the planned record name and CNAME target.

## Pre-flight

1. The prod custom domain and its CNAME now live in the **shared root** (`iac/shared`).
   There is exactly one Static Web App (`swa-bccweb-shared`) shared across the whole
   topology — it is not created separately for each environment. Run
   `terraform -chdir=iac/shared init -backend-config=../env/shared.backend.hcl` and
   `terraform -chdir=iac/shared apply -var-file=../env/shared.tfvars -var-file=../env/shared.generated.tfvars`. This one apply
   provisions the SWA, the ACS email domain, and (when `production_hostname` and
   `dns_zone_name` are both set) the production CNAME together.
2. Read the operator-facing outputs from the shared root:
   ```bash
 terraform -chdir=iac/shared output acs_dns_records_for_operator
 terraform -chdir=iac/shared output -raw swa_default_hostname
 terraform -chdir=iac/shared output -raw swa_name
   ```
   `acs_dns_records_for_operator` exposes lowercase `domain_ownership`, `spf`,
   `dkim`, `dkim2`, and `dmarc` keys. Each value is Azure's record object;
   use its returned `type`, `name`, and `value` fields at the registrar. For
   automation, print tab-separated fields with:
   ```bash
   terraform -chdir=iac/shared output -json acs_dns_records_for_operator |
     jq -r 'to_entries[] | [.key, .value.type, .value.name, .value.value] | @tsv'
   ```
3. `swa_default_hostname` is the stable SWA default hostname (e.g.
   `nice-stone-0a1b2c3d4.azurestaticapps.net`) to use as the CNAME target at the
   registrar, or to compare against when Terraform manages the CNAME itself.
4. The shared root manages the production custom domain and CNAME only when both
   `var.production_hostname` and `var.dns_zone_name` are non-empty in `iac/env/shared.tfvars`.
   When they are empty, the operator must create the production CNAME manually at the
   registrar, pointed at `swa_default_hostname`.

## TTL strategy

DNS TTL controls how long resolvers cache the record. A high TTL is good for steady-state cost / load but is fatal during a botched cutover — recovery cannot ship faster than the cached TTL expires.

| Phase                                | TTL    | Why                                                                                              |
|--------------------------------------|--------|--------------------------------------------------------------------------------------------------|
| T-24h: pre-cutover lower-TTL         | 300s   | Forces resolvers to start re-asking. By cutover time the world has the 300s cached, not the 3600s previous value, so a rollback completes within ~5 minutes. |
| Cutover: flip CNAME target           | 300s   | Keep the 300s value during the entire change window. Do not raise it back until you are sure traffic is healthy. |
| T+24h after stable traffic: restore  | 3600s  | Once Application Insights confirms a full 24h of clean traffic, raise TTL back to 3600s to reduce resolver load and improve repeat-visitor latency. |

Apply the same TTL schedule to the ACS SPF / DKIM / DMARC TXT records during the email-verification window — if a wrong DKIM value gets published you want to be able to correct it in minutes, not hours.

**Terraform path:** `iac/shared/dns.tf` hard-codes `ttl = 3600`. To run the lower-TTL phase, manually `az network dns record-set cname update --ttl 300 ...` 24h before cutover, then re-run `terraform -chdir=iac/shared apply -var-file=../env/shared.tfvars -var-file=../env/shared.generated.tfvars` after the stability window to let Terraform reassert 3600. Do **not** edit `ttl` in `dns.tf` during the cutover window — that would race with the operator's portal change.

**Manual / registrar path:** lower the TTL on the existing record at the registrar 24h before cutover, change the target at cutover, raise the TTL 24h after stable traffic. Same schedule.

## ACS email domain verification

For each record returned by `terraform -chdir=iac/shared output acs_dns_records_for_operator`:

1. **`domain_ownership`** — a TXT record proving you control the domain. Paste `name` and `value` at the registrar. Wait for the Azure portal under the Communication Services > Domains blade to mark the domain Verified.
2. **`spf`** — TXT, value typically `v=spf1 include:azurecomm.net -all`. If the apex already has an SPF, merge the `include:azurecomm.net` clause rather than publishing a second SPF record (only one v=spf1 record is allowed per host).
3. **`dkim`** and **`dkim2`** — CNAME records under `selector1-azurecomm-prod-net._domainkey.<your-domain>` and `selector2-azurecomm-prod-net._domainkey.<your-domain>` pointing at Azure-managed targets.
4. **`dmarc`** — use the returned TXT `name` and `value`. For first cutover,
   ensure the policy in the value is `p=none`; this is an operator policy,
   not a separate Terraform recommendation output. Tighten to
   `p=quarantine` after one clean week of DMARC aggregate reports, and to
   `p=reject` only after a second clean week.
5. After Azure reports every required domain check as Verified, set
   `link_acs_email_domain = true` in `iac/env/shared.tfvars`, commit it through
   review, and run the shared Terraform apply workflow. Confirm the final plan
   changes only `acs-bccweb-shared.properties.linkedDomains` and that the apply
   succeeds before treating outbound mail as enabled.

**DMARC policy progression — non-negotiable for first deployment:**

| Week     | Policy            | Rationale                                                                 |
|----------|-------------------|--------------------------------------------------------------------------|
| 0 (now)  | `p=none`          | Misconfigured SPF / DKIM will not cause silent drops. Aggregate reports start arriving. |
| +1 stable| `p=quarantine`    | Failing mail lands in spam, not the inbox. Still recoverable.            |
| +2 stable| `p=reject`        | Failing mail is bounced. Only flip after two full weeks of clean reports. |

## Production CNAME cutover

The custom domain and CNAME are owned by the **shared root** (`iac/shared`), because
there is a single Static Web App shared across the whole topology — it is not
created separately per environment. There is no per-environment DNS record to manage.

### Terraform-managed path (production_hostname and dns_zone_name set)

```bash
terraform -chdir=iac/shared init -backend-config=../env/shared.backend.hcl
terraform -chdir=iac/shared apply -var-file=../env/shared.tfvars -var-file=../env/shared.generated.tfvars
```

The plan should show one `azapi_resource.production_cname[0]` to add. After apply, the record exists in the Azure DNS zone with TTL 3600. To run the T-24h lower-TTL phase, run:

```bash
set -euo pipefail

DNS_ZONE_NAME="flyparagliding.org.uk"
# Set this to the DNS zone's resource group, or leave it empty when the
# resource group name is the same as DNS_ZONE_NAME (the dns.tf fallback).
DNS_ZONE_RESOURCE_GROUP_NAME=""

DNS_ZONE_RG="${DNS_ZONE_RESOURCE_GROUP_NAME:-$DNS_ZONE_NAME}"
DNS_RECORD_NAME="$({
  terraform -chdir=iac/shared show -json |
    jq -er '
      [.. | objects
       | select(.address? == "azapi_resource.production_cname[0]")
       | .values.name
       | select(type == "string" and length > 0)]
      | if length == 1 then .[0]
        else error("expected exactly one Terraform-managed production CNAME")
        end
    '
})"

az network dns record-set cname update \
  --resource-group "$DNS_ZONE_RG" \
  --zone-name "$DNS_ZONE_NAME" \
  --name "$DNS_RECORD_NAME" \
  --set ttl=300
```

`DNS_RECORD_NAME` comes directly from the single
`azapi_resource.production_cname[0]` instance in the shared root's current Terraform
state, so it mirrors the exact resource `name` Terraform manages and fails
closed if that instance is absent, duplicated, or unnamed. `DNS_ZONE_NAME` and
`DNS_ZONE_RESOURCE_GROUP_NAME` must match `dns_zone_name` and
`dns_zone_resource_group_name` in `iac/env/shared.tfvars`. The resource group is
deliberately **not** the shared `shared_rg_name`: `dns.tf` addresses the
configured DNS-zone resource group, falling back to the zone name only when
`dns_zone_resource_group_name` is empty.

24h after stable traffic, run `terraform -chdir=iac/shared apply -var-file=../env/shared.tfvars -var-file=../env/shared.generated.tfvars` again to let Terraform reset the TTL to 3600.

### Manual / registrar path (var.dns_zone_name empty)

When DNS is NOT hosted in Azure (e.g. domain at Gandi, Cloudflare, Namecheap):

1. Log in to the registrar's DNS console.
2. Locate the existing CNAME (or A record) for `<production_hostname>`.
3. 24h before cutover: lower TTL to 300s. Do not change the target yet.
4. At cutover: change the target to the value returned by `terraform -chdir=iac/shared output -raw swa_default_hostname`. Keep TTL at 300s.
5. Wait for propagation. Run `bash scripts/iac/validate-dns.sh` (see below) to verify.
6. Register the hostname on the shared SWA so Azure can issue the certificate:
   ```bash
   az staticwebapp hostname set --name swa-bccweb-shared \
     --resource-group "$SHARED_RG_NAME" \
     --hostname <production_hostname> \
     --validation-method cname-delegation
   ```
   Terraform deliberately does not manage the custom domain on this path — auto-creating
   the `azapi` SWA `customDomains` child here would block the shared `apply` waiting on a
   registrar CNAME the operator controls out-of-band, so this manual step is required
   whenever `dns_zone_name` is empty.
7. After 24h of stable traffic and clean Application Insights metrics, raise TTL back to 3600s.

Do not delete the old target until the rollback window in `docs/runbooks/cutover.md` closes.

## Validation

Run the automated smoke script:

```bash
SWA_HOST="$(terraform -chdir=iac/shared output -raw swa_default_hostname)"

PROD_HOST=bcc.flyparagliding.org.uk \
SWA_HOST="$SWA_HOST" \
API_HOST=func-bccweb-prod.azurewebsites.net \
ACS_EMAIL_DOMAIN=email.matt-ffffff.com \
  bash scripts/iac/validate-dns.sh
```

Deriving `SWA_HOST` from the shared root's `swa_default_hostname` output makes this
command valid in both managed and manual modes.

The script:

1. `dig +short $PROD_HOST CNAME` — asserts it returns `$SWA_HOST`.
2. `curl -sSI https://$PROD_HOST/` — asserts a 200 status (cert valid + SPA reachable).
3. `curl -fsS https://$API_HOST/api/health | jq` — asserts `.status == "ok"`.
4. `dig $ACS_EMAIL_DOMAIN TXT` — asserts SPF, DKIM CNAME, and DMARC TXT all resolve with a `p=` policy clause.

Set `CHECK_ACS_DNS=0` to skip step 4 if the email domain is being verified later in a separate change.

Capture the script's output into `.omo/evidence/task-51-dns.txt` as cutover evidence.

## Rollback

If the production CNAME flip causes issues:

1. At the registrar (or via `az network dns record-set cname update`), change the CNAME target back to the previous value (legacy host).
2. Because TTL is 300s during the cutover window, resolvers re-fetch within ~5 minutes globally.
3. Investigate via Application Insights `requests` / `exceptions` tables (T46/T47 alerts already wired in).
4. Do **not** raise TTL back to 3600s until you have a confirmed fix and a fresh successful cutover.

ACS email DNS records can be left in place — they are additive and do not affect web traffic. If a DKIM/DMARC value was wrong, simply update the TXT/CNAME at the registrar; the 300s TTL gets you a 5-minute recovery window for mail deliverability too.

## Sign-off

Attach `.omo/evidence/task-51-dns.txt` (validate-dns.sh PASS output) and the live Azure portal screenshot of the ACS Domains blade showing Verified status to the cutover record under the "ACS email domain DNS verification" row in `docs/runbooks/cutover.md`.

The Mail-Tester / DMARC-aggregate-report score validation (target ≥ 9/10) is deferred to the live cutover window — capture it under `.omo/evidence/task-51-mail-score.txt` after the first week of mail traffic.
