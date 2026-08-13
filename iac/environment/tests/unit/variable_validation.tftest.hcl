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
      env_umi_principal_ids = {
        unit = "00000000-0000-0000-0000-000000000006"
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
  app_url                      = "https://unit.example.test"
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

run "app_url_accepts_azure_swa_hostname" {
  command = plan

  variables {
    app_url = "https://nice-desert-0f55cb503-staging.westeurope.7.azurestaticapps.net"
  }

  assert {
    condition     = var.app_url == lower(trimspace(var.app_url)) && length(var.app_url) <= 261 && can(regex("^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$", var.app_url))
    error_message = "app_url must be a canonical lowercase HTTPS origin with a DNS hostname."
  }
}

run "app_url_accepts_custom_hostname" {
  command = plan

  variables {
    app_url = "https://www.advance-bcc.uk"
  }
}

run "app_url_rejects_empty_string" {
  command = plan

  variables {
    app_url = ""
  }

  expect_failures = [var.app_url]
}

run "app_url_rejects_bare_origin_without_dot" {
  command = plan

  variables {
    app_url = "https://localhost"
  }

  expect_failures = [var.app_url]
}

run "app_url_rejects_credentials" {
  command = plan

  variables {
    app_url = "https://user:pass@example.test"
  }

  expect_failures = [var.app_url]
}

run "app_url_rejects_dotless_host" {
  command = plan

  variables {
    app_url = "https://intranet"
  }

  expect_failures = [var.app_url]
}

run "app_url_rejects_host_underscore" {
  command = plan

  variables {
    app_url = "https://bad_host.example.test"
  }

  expect_failures = [var.app_url]
}

run "app_url_rejects_empty_dns_label" {
  command = plan

  variables {
    app_url = "https://bad..example.test"
  }

  expect_failures = [var.app_url]
}

run "app_url_rejects_leading_label_hyphen" {
  command = plan

  variables {
    app_url = "https://-bad.example.test"
  }

  expect_failures = [var.app_url]
}

run "app_url_rejects_trailing_label_hyphen" {
  command = plan

  variables {
    app_url = "https://bad-.example.test"
  }

  expect_failures = [var.app_url]
}

run "app_url_rejects_ipv4_literal" {
  command = plan

  variables {
    app_url = "https://192.0.2.1"
  }

  expect_failures = [var.app_url]
}

run "app_url_rejects_http" {
  command = plan

  variables {
    app_url = "http://www.advance-bcc.uk"
  }

  expect_failures = [var.app_url]
}

run "app_url_rejects_uppercase" {
  command = plan

  variables {
    app_url = "https://WWW.advance-bcc.uk"
  }

  expect_failures = [var.app_url]
}

run "app_url_rejects_explicit_port" {
  command = plan

  variables {
    app_url = "https://www.advance-bcc.uk:443"
  }

  expect_failures = [var.app_url]
}

run "app_url_rejects_trailing_slash" {
  command = plan

  variables {
    app_url = "https://www.advance-bcc.uk/"
  }

  expect_failures = [var.app_url]
}

run "app_url_rejects_path" {
  command = plan

  variables {
    app_url = "https://www.advance-bcc.uk/auth"
  }

  expect_failures = [var.app_url]
}

run "app_url_rejects_query_string" {
  command = plan

  variables {
    app_url = "https://www.advance-bcc.uk?mode=test"
  }

  expect_failures = [var.app_url]
}

run "app_url_rejects_fragment" {
  command = plan

  variables {
    app_url = "https://www.advance-bcc.uk#auth"
  }

  expect_failures = [var.app_url]
}

run "app_url_rejects_embedded_whitespace" {
  command = plan

  variables {
    app_url = "https://www.advance bcc.uk"
  }

  expect_failures = [var.app_url]
}

run "app_url_rejects_64_character_dns_label" {
  command = plan

  variables {
    app_url = "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.example.test"
  }

  expect_failures = [var.app_url]
}

run "app_url_rejects_total_length_over_261" {
  command = plan

  variables {
    app_url = "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }

  expect_failures = [var.app_url]
}
