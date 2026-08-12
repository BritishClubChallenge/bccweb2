#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
shared_dir="$repo_root/iac/shared"

resource_declarations="$({
  awk '
    function brace_delta(value, copy, opens, closes) {
      copy = value
      opens = gsub(/\{/, "{", copy)
      copy = value
      closes = gsub(/\}/, "}", copy)
      return opens - closes
    }

    /^[[:space:]]*resource[[:space:]]+"azapi_resource"[[:space:]]+"[^"]+"[[:space:]]*\{/ {
      split($0, fields, "\"")
      resource_name = fields[4]
      resource_type = ""
      depth = brace_delta($0)
      in_resource = 1
      next
    }

    in_resource {
      if ($0 ~ /^[[:space:]]*type[[:space:]]*=[[:space:]]*"[^"]+"/) {
        split($0, fields, "\"")
        resource_type = fields[2]
      }
      depth += brace_delta($0)
      if (depth == 0) {
        if (resource_type == "") {
          printf "Missing literal type for azapi_resource.%s\n", resource_name > "/dev/stderr"
          exit 1
        }
        print resource_name "\t" resource_type
        in_resource = 0
      }
    }
  ' "$shared_dir"/*.tf
} | while IFS=$'\t' read -r resource_name resource_type; do
  if [[ "$resource_type" == Microsoft.Authorization/roleAssignments@* ]]; then
    continue
  fi
  printf 'azapi_resource.%s\n' "$resource_name"
done | LC_ALL=C sort)"

expected_declarations="$(printf '%s\n' \
  'azapi_resource.acs' \
  'azapi_resource.acs_email' \
  'azapi_resource.acs_email_domain' \
  'azapi_resource.acs_sender_username' \
  'azapi_resource.ai' \
  'azapi_resource.law' \
  'azapi_resource.production_cname' \
  'azapi_resource.swa' \
  'azapi_resource.swa_custom_domain' | LC_ALL=C sort)"

if [[ "$resource_declarations" != "$expected_declarations" ]]; then
  printf 'Shared managed-resource declaration contract failed.\nExpected:\n%s\nActual:\n%s\n' \
    "$expected_declarations" "$resource_declarations" >&2
  exit 1
fi

environment_default_line="$(awk '
  /^variable "environments"[[:space:]]*\{/ { in_variable = 1; next }
  in_variable && /^[[:space:]]*default[[:space:]]*=/ { print; exit }
  in_variable && /^}/ { exit }
' "$shared_dir/variables.tf")"
environment_names="$(printf '%s\n' "$environment_default_line" | grep -oE '"[^"]+"' | tr -d '"' | LC_ALL=C sort)"
expected_environments="$(printf '%s\n' prod staging)"

if [[ "$environment_names" != "$expected_environments" ]]; then
  printf 'Shared Application Insights environment contract failed.\nExpected:\n%s\nActual:\n%s\n' \
    "$expected_environments" "$environment_names" >&2
  exit 1
fi

managed_set="$({
  while IFS= read -r address; do
    case "$address" in
      azapi_resource.ai)
        while IFS= read -r environment; do
          printf 'azapi_resource.ai["%s"]\n' "$environment"
        done <<< "$environment_names"
        ;;
      azapi_resource.production_cname|azapi_resource.swa_custom_domain)
        printf '%s[0] (when gated)\n' "$address"
        ;;
      *)
        printf '%s\n' "$address"
        ;;
    esac
  done <<< "$resource_declarations"
} | LC_ALL=C sort)"

expected_managed_set="$(printf '%s\n' \
  'azapi_resource.acs' \
  'azapi_resource.acs_email' \
  'azapi_resource.acs_email_domain' \
  'azapi_resource.acs_sender_username' \
  'azapi_resource.ai["prod"]' \
  'azapi_resource.ai["staging"]' \
  'azapi_resource.law' \
  'azapi_resource.production_cname[0] (when gated)' \
  'azapi_resource.swa' \
  'azapi_resource.swa_custom_domain[0] (when gated)' | LC_ALL=C sort)"

if [[ "$managed_set" != "$expected_managed_set" ]]; then
  printf 'Shared managed-resource contract failed.\nExpected:\n%s\nActual:\n%s\n' \
    "$expected_managed_set" "$managed_set" >&2
  exit 1
fi

resource_block() {
  local resource_name="$1"
  awk -v target="$resource_name" '
    function brace_delta(value, copy, opens, closes) {
      copy = value
      opens = gsub(/\{/, "{", copy)
      copy = value
      closes = gsub(/\}/, "}", copy)
      return opens - closes
    }
    $0 ~ "^[[:space:]]*resource[[:space:]]+\"azapi_resource\"[[:space:]]+\"" target "\"[[:space:]]*\\{" {
      in_resource = 1
      depth = brace_delta($0)
      print
      if (depth == 0) exit
      next
    }
    in_resource {
      print
      depth += brace_delta($0)
      if (depth == 0) exit
    }
  ' "$shared_dir/acs.tf"
}

for protected_resource in acs_email acs; do
  resource_block "$protected_resource" | grep -Eq '^[[:space:]]*prevent_destroy[[:space:]]*=[[:space:]]*true' || {
    printf 'Shared lifecycle contract failed: azapi_resource.%s must retain prevent_destroy=true.\n' "$protected_resource" >&2
    exit 1
  }
done

for replaceable_resource in acs_email_domain acs_sender_username; do
  if resource_block "$replaceable_resource" | grep -Eq '^[[:space:]]*prevent_destroy[[:space:]]*='; then
    printf 'Shared lifecycle contract failed: azapi_resource.%s must remain replaceable.\n' "$replaceable_resource" >&2
    exit 1
  fi
done

actual_outputs="$(grep -hoE '^output "[^"]+"' "$shared_dir"/*.tf | cut -d '"' -f 2 | LC_ALL=C sort)"
expected_outputs="$(printf '%s\n' \
  'acs_dns_records_for_operator' \
  'acs_email_domain_id' \
  'acs_id' \
  'acs_sender_address' \
  'app_insights_ids' \
  'env_umi_principal_ids' \
  'log_analytics_workspace_id' \
  'swa_default_hostname' \
  'swa_id' \
  'swa_name' | LC_ALL=C sort)"

if [[ "$actual_outputs" != "$expected_outputs" ]]; then
  printf 'Shared output-name contract failed.\nExpected:\n%s\nActual:\n%s\n' \
    "$expected_outputs" "$actual_outputs" >&2
  exit 1
fi

output_bodies="$(awk '
  function brace_delta(value, copy, opens, closes) {
    copy = value
    opens = gsub(/\{/, "{", copy)
    copy = value
    closes = gsub(/\}/, "}", copy)
    return opens - closes
  }

  /^[[:space:]]*output[[:space:]]+"[^"]+"[[:space:]]*\{/ {
    depth = brace_delta($0)
    in_output = 1
    next
  }

  in_output {
    print FILENAME ":" FNR ":" $0
    depth += brace_delta($0)
    if (depth == 0) {
      in_output = 0
    }
  }
' "$shared_dir"/*.tf)"

if printf '%s\n' "$output_bodies" | grep -nE '(listKeys|ConnectionString|primaryConnectionString)'; then
  printf 'Shared output bodies must not reference secret-producing fields or operations.\n' >&2
  exit 1
fi

printf 'Shared managed-resource contract passed. Exact managed set:\n%s\n' "$managed_set"
printf 'Shared output contract passed: 10 exact non-secret outputs.\n'
