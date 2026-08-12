# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
override_data {
  target = data.azapi_client_config.current

  values = {
    object_id = "00000000-0000-0000-0000-000000000002"
  }
}

override_data {
  target = data.terraform_remote_state.shared

  values = {
    outputs = {
      app_insights_ids = {
        unit = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bccweb-shared/providers/Microsoft.Insights/components/appi-bccweb-unit"
      }
      acs_id             = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bccweb-shared/providers/Microsoft.Communication/communicationServices/acs-bccweb-shared"
      acs_sender_address = "noreply@mail.example.test"
    }
  }
}

override_module {
  target = module.stamp

  outputs = {
    resource_group_name           = "rg-bccweb-unit"
    function_app_name             = "func-bccweb-unit"
    function_app_default_hostname = "unit.example.test"
    storage_account_name_runtime  = "stbccwebunitrt"
    storage_account_name_data     = "stbccwebunitdata"
    key_vault_name                = "kv-bccweb-unit"
    key_vault_uri                 = "https://kv-bccweb-unit.vault.azure.net/"
  }
}

variables {
  stamp_name                   = "unit"
  stamp_rg_name                = "rg-bccweb-unit"
  tfstate_resource_group_name  = "rg-bccweb-tfstate"
  tfstate_storage_account_name = "stbccwebtfstate"
  operator_principal_id        = "00000000-0000-0000-0000-000000000006"
  ops_email                    = "ops@example.test"
  puretrack_api_key            = "TEST_PT_KEY_SENTINEL"
  puretrack_email              = "TEST_PT_EMAIL@example.test"
  puretrack_password           = "TEST_PT_PASSWORD_SENTINEL"
}

run "stamp_rg_name_rejects_whitespace" {
  command = plan

  variables {
    stamp_rg_name = " \t "
  }

  expect_failures = [var.stamp_rg_name]
}

run "tfstate_resource_group_name_rejects_whitespace" {
  command = plan

  variables {
    tfstate_resource_group_name = " \t "
  }

  expect_failures = [var.tfstate_resource_group_name]
}

run "tfstate_storage_account_name_rejects_whitespace" {
  command = plan

  variables {
    tfstate_storage_account_name = " \t "
  }

  expect_failures = [var.tfstate_storage_account_name]
}

run "ops_email_rejects_whitespace" {
  command = plan

  variables {
    ops_email = " \t "
  }

  expect_failures = [var.ops_email]
}

run "puretrack_api_key_rejects_whitespace" {
  command = plan

  variables {
    puretrack_api_key = " \t "
  }

  expect_failures = [var.puretrack_api_key]
}

run "puretrack_email_rejects_whitespace" {
  command = plan

  variables {
    puretrack_email = " \t "
  }

  expect_failures = [var.puretrack_email]
}

run "puretrack_password_rejects_whitespace" {
  command = plan

  variables {
    puretrack_password = " \t "
  }

  expect_failures = [var.puretrack_password]
}
