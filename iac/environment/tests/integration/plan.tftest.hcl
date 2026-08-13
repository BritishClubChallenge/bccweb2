# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
# REQUIRES ambient 'az login'. Plan-only; NEVER 'apply'.
# Run:
#   terraform -chdir=iac/environment init -backend=false -test-directory=tests/integration
#   terraform -chdir=iac/environment test -test-directory=tests/integration
#
# This file is the INTEGRATION counterpart to tests/unit/stamp.tftest.hcl.
# Unlike the unit tests (which mock_provider every provider for offline runs),
# this test talks to the REAL azapi provider against a real subscription.
# It only PLANs — it never APPLIES — so it is safe to run on a clean
# subscription, but it still requires:
#   * Ambient `az login` so azapi can authenticate.
#   * Provider read access to the shared Application Insights and ACS resources
#     referenced by the mocked shared-state output IDs below.
#
# This file is intentionally excluded from default `terraform test` runs
# (the default `-test-directory=tests` discovery picks up tests/unit/ only
# when invoked explicitly). CI runs unit tests by default; integration is
# an operator-invoked check.

provider "azapi" {}

variables {
  stamp_name = "inttest"
  location   = "uksouth"
  app_url    = "https://integration-test.example.invalid"

  stamp_rg_name = "rg-bccweb-integration-test"

  tfstate_resource_group_name  = "rg-bccweb-tfstate"
  tfstate_storage_account_name = "stbccweb13afe"

  allowed_origins = ["https://integration-test.example.invalid"]

  ops_email         = "ops-integration-test@example.invalid"
  slack_webhook_url = ""

  # Sentinel values — never real secrets. The plan-only invocation does not
  # write these anywhere; they only need to satisfy `nullable = false`.
  puretrack_api_key  = "TEST_PURETRACK_API_KEY"
  puretrack_email    = "TEST_PURETRACK_EMAIL@example.invalid"
  puretrack_password = "TEST_PURETRACK_PASSWORD"

  jwt_secret_version = "1"
  acs_secret_version = "1"
}

override_data {
  target = data.terraform_remote_state.shared

  # IMPORTANT — REAL SHARED-RESOURCE READS:
  # The stamp reads the Application Insights connection string from Azure, so
  # the Application Insights ID must identify a real, existing component. The
  # legacy component is the default stand-in because appi-bccweb-<stamp_name>
  # has not been applied yet. After rollout, repoint this override to the shared
  # appi-bccweb-<stamp_name> output and keep ACS on acs-bccweb-shared.
  # This test remains operator-invoked and plan-only. It is currently rollout-
  # blocked because the intentional real acs-bccweb-shared listKeys read returns
  # 404 until shared infrastructure is applied; do not mock or apply around it.
  values = {
    outputs = {
      app_insights_ids = {
        inttest = "/subscriptions/ba36d2f0-1de7-4f76-a094-d14fecc61d70/resourceGroups/bccweb-prod-9364/providers/Microsoft.Insights/components/aibccwebprod9364"
      }
      env_umi_principal_ids = {
        inttest = "00000000-0000-0000-0000-000000000006"
      }
      acs_id             = "/subscriptions/ba36d2f0-1de7-4f76-a094-d14fecc61d70/resourceGroups/rg-bccweb-shared/providers/Microsoft.Communication/communicationServices/acs-bccweb-shared"
      acs_sender_address = "no-reply@integration-test.example.invalid"
    }
  }
}

run "plan_against_real_provider" {
  command = plan

  # Plan must succeed against authenticated AzAPI reads while shared state is mocked.
  expect_failures = []

  # Guardrail: the root module must actually be planning the stamp module.
  assert {
    condition     = module.stamp.resource_group_name == var.stamp_rg_name
    error_message = "Root module must plan exactly one stamp child module."
  }
}
