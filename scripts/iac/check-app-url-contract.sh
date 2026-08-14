#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
root_variables="$repo_root/iac/environment/variables.tf"
root_main="$repo_root/iac/environment/main.tf"
stamp_variables="$repo_root/iac/environment/modules/stamp/variables.tf"
stamp_functions="$repo_root/iac/environment/modules/stamp/functions.tf"
fixture_variables="$repo_root/iac/environment/tests/unit/stamp-fixture/variables.tf"
fixture_functions="$repo_root/iac/environment/tests/unit/stamp-fixture/functions.tf"
integration_fixture="$repo_root/iac/environment/tests/integration/plan.tftest.hcl"
expected_condition='condition = var.app_url == lower(trimspace(var.app_url)) && length(var.app_url) <= 261 && can(regex("^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$", var.app_url))'

fail() {
  printf 'App URL contract failed: %s\n' "$*" >&2
  exit 1
}

hcl_block() {
  local declaration="$1"
  local file="$2"
  awk -v declaration="$declaration" '
    function brace_delta(value, copy, opens, closes) {
      copy = value
      opens = gsub(/\{/, "{", copy)
      copy = value
      closes = gsub(/\}/, "}", copy)
      return opens - closes
    }
    $0 == declaration {
      found = 1
      in_block = 1
      depth = brace_delta($0)
    }
    in_block {
      print
      if ($0 != declaration) depth += brace_delta($0)
      if (depth == 0) exit
    }
    END { if (!found) exit 1 }
  ' "$file"
}

app_url_variable_block() {
  hcl_block 'variable "app_url" {' "$1"
}

assert_app_url_variable() {
  local file="$1"
  local block
  local actual_condition

  block="$(app_url_variable_block "$file")" || fail "$file must declare variable \"app_url\""
  printf '%s\n' "$block" | grep -Eq '^[[:space:]]*type[[:space:]]*=[[:space:]]*string[[:space:]]*$' ||
    fail "$file app_url must have type string"
  printf '%s\n' "$block" | grep -Eq '^[[:space:]]*nullable[[:space:]]*=[[:space:]]*false[[:space:]]*$' ||
    fail "$file app_url must set nullable = false"
  if printf '%s\n' "$block" | grep -Eq '^[[:space:]]*default[[:space:]]*='; then
    fail "$file app_url must be required and have no default"
  fi

  actual_condition="$(printf '%s\n' "$block" | sed -nE 's/^[[:space:]]*condition[[:space:]]*=[[:space:]]*/condition = /p')"
  [[ "$actual_condition" == "$expected_condition" ]] ||
    fail "$file app_url validation condition does not match the canonical contract"
}

assert_app_url_variable "$root_variables"
assert_app_url_variable "$stamp_variables"

stamp_module_block="$(hcl_block 'module "stamp" {' "$root_main")" || fail "$root_main must declare module \"stamp\""
forwarding_count="$(printf '%s\n' "$stamp_module_block" | grep -Ec '^[[:space:]]*app_url[[:space:]]*=[[:space:]]*var\.app_url[[:space:]]*$' || true)"
[[ "$forwarding_count" == "1" ]] ||
  fail "$root_main module.stamp must forward app_url = var.app_url exactly once; found $forwarding_count"

app_url_setting_count() {
  grep -Ec 'name[[:space:]]*=[[:space:]]*"APP_URL"' "$1" || true
}

canonical_app_url_setting_lines() {
  grep -E '^[[:space:]]*\{[[:space:]]*name[[:space:]]*=[[:space:]]*"APP_URL"[[:space:]]*,[[:space:]]*value[[:space:]]*=[[:space:]]*var\.app_url[[:space:]]*\},[[:space:]]*$' "$1" || true
}

real_setting_count="$(app_url_setting_count "$stamp_functions")"
[[ "$real_setting_count" == "1" ]] ||
  fail "$stamp_functions must contain exactly one APP_URL setting; found $real_setting_count"
real_setting_lines="$(canonical_app_url_setting_lines "$stamp_functions")"
[[ -n "$real_setting_lines" ]] ||
  fail "$stamp_functions APP_URL setting must be sourced from var.app_url"

assert_app_url_variable "$fixture_variables"
real_variable_block="$(app_url_variable_block "$stamp_variables")"
fixture_variable_block="$(app_url_variable_block "$fixture_variables")"
[[ "$fixture_variable_block" == "$real_variable_block" ]] ||
  fail "$fixture_variables app_url declaration must match the real stamp module byte-for-byte"

fixture_setting_count="$(app_url_setting_count "$fixture_functions")"
[[ "$fixture_setting_count" == "1" ]] ||
  fail "$fixture_functions must contain exactly one APP_URL setting; found $fixture_setting_count"
fixture_setting_lines="$(canonical_app_url_setting_lines "$fixture_functions")"
[[ -n "$fixture_setting_lines" ]] ||
  fail "$fixture_functions APP_URL setting must be sourced from var.app_url"
[[ "$fixture_setting_lines" == "$real_setting_lines" ]] ||
  fail "$fixture_functions APP_URL setting must match the real stamp module byte-for-byte"

integration_app_url_count="$(grep -Ec '^[[:space:]]*app_url[[:space:]]*=' "$integration_fixture" || true)"
[[ "$integration_app_url_count" == "1" ]] ||
  fail "$integration_fixture must carry app_url exactly once; found $integration_app_url_count"

awk '
  /^[[:space:]]*env_umi_principal_ids[[:space:]]*=[[:space:]]*\{/ {
    in_map = 1
    next
  }
  in_map && /^[[:space:]]*inttest[[:space:]]*=/ { found = 1 }
  in_map && /^[[:space:]]*\}/ { exit }
  END { if (!found) exit 1 }
' "$integration_fixture" ||
  fail "$integration_fixture must carry env_umi_principal_ids.inttest"

printf 'App URL contract passed: root, stamp, fixture, Function setting, and integration inputs agree.\n'
