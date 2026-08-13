#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
set -euo pipefail

# validate-dns.sh — operator post-cutover smoke check (T51).
#
# Verifies that:
#   1. The production hostname CNAME resolves to the SWA default hostname.
#   2. The production site responds with HTTP 200 over HTTPS (cert valid + SPA
#      reachable).
#   3. The API health endpoint returns { status: "ok" }.
#   4. (Optional) ACS email domain SPF / DKIM / DMARC TXT records are present
#      via public DNS resolution — published in the delegated Azure DNS zone
#      email.matt-ffffff.com (resource group rg-dns), not at the registrar.
#
# Usage:
#   PROD_HOST=www.advance-bcc.uk \
#   SWA_HOST=nice-stone-0a1b2c3d4.azurestaticapps.net \
#   API_HOST=func-bccweb-prod.azurewebsites.net \
#   ACS_EMAIL_DOMAIN=email.matt-ffffff.com \
#     bash scripts/iac/validate-dns.sh
#
# Set CHECK_ACS_DNS=0 to skip the SPF/DKIM/DMARC TXT lookups when the ACS
# email domain's records have not yet been published/verified (e.g. still
# pending in the delegated Azure DNS zone, or a separate later change).
#
# Exits non-zero on the first failing check. The script prints PASS/FAIL on
# every line so the operator can capture the output as cutover evidence.

PROD_HOST="${PROD_HOST:-}"
SWA_HOST="${SWA_HOST:-}"
API_HOST="${API_HOST:-}"
ACS_EMAIL_DOMAIN="${ACS_EMAIL_DOMAIN:-}"
CHECK_ACS_DNS="${CHECK_ACS_DNS:-1}"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

require_var() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    fail "$name must be set"
  fi
}

require_tool() {
  local tool="$1"
  if ! command -v "$tool" >/dev/null 2>&1; then
    fail "$tool not found on PATH"
  fi
}

require_var PROD_HOST
require_var SWA_HOST
require_var API_HOST
require_tool dig
require_tool curl

# ─── 1. CNAME resolution ─────────────────────────────────────────────────────
echo "[1/4] dig CNAME $PROD_HOST -> expect $SWA_HOST"
CNAME_TARGET="$(dig +short "$PROD_HOST" CNAME | sed 's/\.$//' | head -n1)"
if [[ -z "$CNAME_TARGET" ]]; then
  fail "dig returned no CNAME for $PROD_HOST"
fi
if [[ "$CNAME_TARGET" != "$SWA_HOST" ]]; then
  fail "CNAME mismatch: $PROD_HOST -> $CNAME_TARGET (expected $SWA_HOST)"
fi
echo "PASS: $PROD_HOST CNAME -> $CNAME_TARGET"

# ─── 2. HTTPS reachability of the SPA ────────────────────────────────────────
echo "[2/4] curl https://$PROD_HOST/ -> expect HTTP/2 200 (or HTTP/1.1 200)"
STATUS_LINE="$(curl -sSI --max-time 15 "https://$PROD_HOST/" | head -n1 | tr -d '\r')"
if [[ -z "$STATUS_LINE" ]]; then
  fail "no HTTP status line from https://$PROD_HOST/"
fi
case "$STATUS_LINE" in
  "HTTP/2 200" | "HTTP/2.0 200" | "HTTP/1.1 200 OK" | "HTTP/1.1 200")
    echo "PASS: $STATUS_LINE"
    ;;
  *)
    fail "unexpected status from https://$PROD_HOST/ : $STATUS_LINE"
    ;;
esac

# ─── 3. API health ───────────────────────────────────────────────────────────
echo "[3/4] curl https://$API_HOST/api/health -> expect status=ok"
require_tool jq
HEALTH_JSON="$(curl -fsS --max-time 15 "https://$API_HOST/api/health")"
if ! echo "$HEALTH_JSON" | jq -e '.status == "ok"' >/dev/null; then
  fail "health endpoint did not report status=ok: $HEALTH_JSON"
fi
echo "PASS: API health ok"

# ─── 4. (Optional) ACS email-domain TXT records ──────────────────────────────
if [[ "$CHECK_ACS_DNS" != "1" ]]; then
  echo "[4/4] SKIP: CHECK_ACS_DNS=$CHECK_ACS_DNS"
  echo ""
  echo "ALL CHECKS PASSED"
  exit 0
fi

require_var ACS_EMAIL_DOMAIN
echo "[4/4] dig SPF/DKIM/DMARC for $ACS_EMAIL_DOMAIN"

# SPF: a TXT record at the apex of the email domain starting with v=spf1.
SPF_TXT="$(dig +short "$ACS_EMAIL_DOMAIN" TXT | tr -d '"' | grep -i '^v=spf1' || true)"
if [[ -z "$SPF_TXT" ]]; then
  fail "no SPF (v=spf1) TXT record at $ACS_EMAIL_DOMAIN"
fi
echo "PASS: SPF present: $SPF_TXT"

# DKIM: Azure publishes selector1-azurecomm-prod-net._domainkey.<domain> as a
# CNAME. We only check that the CNAME resolves to ANY target.
DKIM_TARGET="$(dig +short "selector1-azurecomm-prod-net._domainkey.$ACS_EMAIL_DOMAIN" CNAME | sed 's/\.$//' | head -n1)"
if [[ -z "$DKIM_TARGET" ]]; then
  fail "no DKIM CNAME at selector1-azurecomm-prod-net._domainkey.$ACS_EMAIL_DOMAIN"
fi
echo "PASS: DKIM CNAME -> $DKIM_TARGET"

# DMARC: TXT at _dmarc.<domain> starting with v=DMARC1.
DMARC_TXT="$(dig +short "_dmarc.$ACS_EMAIL_DOMAIN" TXT | tr -d '"' | grep -i '^v=DMARC1' || true)"
if [[ -z "$DMARC_TXT" ]]; then
  fail "no DMARC (v=DMARC1) TXT record at _dmarc.$ACS_EMAIL_DOMAIN"
fi
if ! echo "$DMARC_TXT" | grep -qi 'p=none\|p=quarantine\|p=reject'; then
  fail "DMARC record at _dmarc.$ACS_EMAIL_DOMAIN missing p= policy: $DMARC_TXT"
fi
echo "PASS: DMARC present: $DMARC_TXT"

echo ""
echo "ALL CHECKS PASSED"
