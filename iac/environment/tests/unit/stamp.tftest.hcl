# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
mock_provider "azapi" {
  alias           = "mock"
  override_during = plan

  mock_data "azapi_client_config" {
    defaults = {
      subscription_id = "00000000-0000-0000-0000-000000000000"
      tenant_id       = "00000000-0000-0000-0000-000000000001"
      object_id       = "00000000-0000-0000-0000-000000000002"
    }
  }

  mock_data "azapi_resource" {
    defaults = {
      output = {
        properties = {
          ConnectionString = "InstrumentationKey=TEST_APPINSIGHTS_SENTINEL;IngestionEndpoint=https://example.test/"
        }
      }
    }
  }

  mock_resource "azapi_resource" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/test-rg/providers/Microsoft.Mock/mockResources/mock"
      output = {
        id   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/test-rg/providers/Microsoft.Mock/mockResources/mock"
        name = "mock"
        properties = {
          defaultHostname  = "test.example.com"
          defaultHostName  = "test.example.com"
          vaultUri         = "https://kv-test.vault.azure.net/"
          ConnectionString = "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://example.test/"
          principalId      = "00000000-0000-0000-0000-000000000000"
          clientId         = "00000000-0000-0000-0000-000000000001"
          customerId       = "00000000-0000-0000-0000-000000000003"
          primaryEndpoints = {
            blob = "https://runtime-unit.blob.core.windows.net/"
          }
          verificationRecords = {
            Domain = { type = "TXT", name = "@", value = "test-domain" }
            SPF    = { type = "TXT", name = "@", value = "v=spf1 include:spf.protection.outlook.com -all" }
            DKIM   = { type = "CNAME", name = "selector1", value = "selector1.example.test" }
            DKIM2  = { type = "CNAME", name = "selector2", value = "selector2.example.test" }
            DMARC  = { type = "TXT", name = "_dmarc", value = "v=DMARC1; p=none" }
          }
        }
      }
    }
  }

  mock_resource "azapi_resource_action" {
    defaults = {
      output = {
        keys = [
          { value = "TEST_STORAGE_KEY_SENTINEL" }
        ]
        primaryConnectionString = "endpoint=https://acs.example.test/;accesskey=TEST_ACS_KEY_SENTINEL"
      }
    }
  }

  mock_resource "azapi_data_plane_resource" {
    defaults = {
      id                     = "https://kv-test.vault.azure.net/secrets/mock"
      sensitive_body         = { value = "mock-secret" }
      sensitive_body_version = { value = "1" }
    }
  }
}

mock_provider "random" {
  alias           = "mock"
  override_during = plan

  mock_resource "random_uuid" {
    defaults = {
      result = "00000000-0000-0000-0000-000000000004"
    }
  }

  mock_resource "random_password" {
    defaults = {
      result = "TEST_JWT_SECRET_SENTINEL"
    }
  }
}

override_resource {
  target          = azapi_resource.fn_umi
  override_during = plan
  values = {
    id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bccweb-unit/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-bccweb-unit-fn"
    output = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bccweb-unit/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-bccweb-unit-fn"
      properties = {
        principalId = "00000000-0000-0000-0000-000000000000"
        clientId    = "00000000-0000-0000-0000-000000000001"
      }
    }
  }
}

variables {
  stamp_name                    = "unit"
  stamp_rg_name                 = "rg-bccweb-unit"
  location                      = "uksouth"
  allowed_origins               = ["https://unit.example.test"]
  storage_sku                   = "Standard_LRS"
  ops_email                     = "ops@example.test"
  slack_webhook_url             = "https://hooks.example.test/unit"
  acs_id                        = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bccweb-shared/providers/Microsoft.Communication/communicationServices/acs-bccweb-shared"
  acs_sender_address            = "noreply@mail.example.test"
  puretrack_api_key             = "TEST_PT_KEY_SENTINEL"
  puretrack_email               = "TEST_PT_EMAIL@example.test"
  puretrack_password            = "TEST_PT_PASSWORD_SENTINEL"
  jwt_secret_version            = "1"
  acs_secret_version            = "1"
  tags                          = { environment = "unit", managed_by = "terraform" }
  app_insights_id               = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/test-rg/providers/Microsoft.Insights/components/test-ai"
  terraform_principal_object_id = "00000000-0000-0000-0000-000000000005"
}

run "module_plans_with_minimum_inputs" {
  command = plan

  providers = {
    azapi  = azapi.mock
    random = random.mock
  }

  module {
    source = "./tests/unit/stamp-fixture"
  }

  assert {
    condition     = azapi_resource.kv.parent_id == "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bccweb-unit" && azapi_resource.function_app.name == "func-bccweb-unit"
    error_message = "The stamp module should plan successfully, parent resources under the pre-created RG, and expose expected core resource names."
  }
}

run "key_vault_has_six_secrets" {
  command = plan

  providers = {
    azapi  = azapi.mock
    random = random.mock
  }

  module {
    source = "./tests/unit/stamp-fixture"
  }

  assert {
    condition = length(azapi_data_plane_resource.secrets) == 6 && length(setsubtract(
      toset(keys(azapi_data_plane_resource.secrets)),
      toset(["jwt-secret", "acs-connection-string", "appinsights-connection-string", "puretrack-api-key", "puretrack-email", "puretrack-password"])
      )) == 0 && length(setsubtract(
      toset(["jwt-secret", "acs-connection-string", "appinsights-connection-string", "puretrack-api-key", "puretrack-email", "puretrack-password"]),
      toset(keys(azapi_data_plane_resource.secrets))
    )) == 0
    error_message = "The Key Vault secret for_each block should plan exactly the six expected secret names."
  }
}

run "function_app_settings_use_kv_references" {
  command = plan

  providers = {
    azapi  = azapi.mock
    random = random.mock
  }

  module {
    source = "./tests/unit/stamp-fixture"
  }

  assert {
    condition = length([
      for setting in azapi_resource.function_app.body.properties.siteConfig.appSettings : setting
      if strcontains(setting.value, "@Microsoft.KeyVault(SecretUri=")
    ]) >= 6
    error_message = "The Function App should use SecretUri Key Vault references for at least six app settings."
  }

  assert {
    condition = (
      one([for setting in azapi_resource.function_app.body.properties.siteConfig.appSettings : setting.value if setting.name == "AzureWebJobsStorage"]) == "DefaultEndpointsProtocol=https;AccountName=stbccwebunitrt;AccountKey=TEST_STORAGE_KEY_SENTINEL;EndpointSuffix=core.windows.net" &&
      one([for setting in azapi_resource.function_app.body.properties.siteConfig.appSettings : setting.value if setting.name == "BLOB_CONNECTION_STRING"]) == "DefaultEndpointsProtocol=https;AccountName=stbccwebunitdata;AccountKey=TEST_STORAGE_KEY_SENTINEL;EndpointSuffix=core.windows.net" &&
      length(azapi_resource_action.storage_runtime_keys_legacy) == 1 &&
      length(azapi_resource_action.storage_data_keys_legacy) == 1 &&
      length([for setting in azapi_resource.function_app.body.properties.siteConfig.appSettings : setting if setting.name == "FUNCTIONS_WORKER_RUNTIME"]) == 0 &&
      one([for setting in azapi_resource.function_app.body.properties.siteConfig.appSettings : setting.value if setting.name == "FUNCTIONS_NODE_BLOCK_ON_ENTRY_POINT_ERROR"]) == "true"
    )
    error_message = "Legacy Flex settings must omit the forbidden worker setting, surface entry-point errors, retain distinct connection strings, and use only the gated legacy key actions."
  }
}

run "function_app_uses_flex_consumption" {
  command = plan

  providers = {
    azapi  = azapi.mock
    random = random.mock
  }

  module {
    source = "./tests/unit/stamp-fixture"
  }

  variables {
    always_ready_count = 1
  }

  assert {
    condition = (
      azapi_resource.service_plan.type == "Microsoft.Web/serverfarms@2024-04-01" &&
      azapi_resource.service_plan.body.kind == "functionapp" &&
      azapi_resource.service_plan.body.sku.name == "FC1" &&
      azapi_resource.service_plan.body.sku.tier == "FlexConsumption" &&
      azapi_resource.service_plan.body.properties.reserved == true
    )
    error_message = "The Function App service plan must use the Linux FC1 Flex Consumption SKU."
  }

  assert {
    condition = (
      azapi_resource.function_app.type == "Microsoft.Web/sites@2024-04-01" &&
      azapi_resource.function_app.body.kind == "functionapp,linux" &&
      azapi_resource.function_app.body.properties.functionAppConfig.runtime.name == "node" &&
      azapi_resource.function_app.body.properties.functionAppConfig.runtime.version == "24" &&
      azapi_resource.function_app.body.properties.functionAppConfig.scaleAndConcurrency.instanceMemoryMB == 2048 &&
      contains([512, 2048, 4096], azapi_resource.function_app.body.properties.functionAppConfig.scaleAndConcurrency.instanceMemoryMB) &&
      azapi_resource.function_app.body.properties.functionAppConfig.scaleAndConcurrency.maximumInstanceCount == 100 &&
      length(azapi_resource.function_app.body.properties.functionAppConfig.scaleAndConcurrency.alwaysReady) == 1 &&
      azapi_resource.function_app.body.properties.functionAppConfig.scaleAndConcurrency.alwaysReady[0].name == "http" &&
      azapi_resource.function_app.body.properties.functionAppConfig.scaleAndConcurrency.alwaysReady[0].instanceCount == 1
    )
    error_message = "Flex must run Node 24 with 2048 MB workers, a 100-instance maximum, and the valid http always-ready group."
  }

  assert {
    condition = (
      azapi_resource.function_app.body.properties.functionAppConfig.deployment.storage.type == "blobContainer" &&
      azapi_resource.function_app.body.properties.functionAppConfig.deployment.storage.value == "https://runtime-unit.blob.core.windows.net/deploymentpackage" &&
      endswith(azapi_resource.function_app.body.properties.functionAppConfig.deployment.storage.value, "/deploymentpackage") &&
      azapi_resource.function_app.body.properties.functionAppConfig.deployment.storage.authentication.type == "StorageAccountConnectionString" &&
      azapi_resource.function_app.body.properties.functionAppConfig.deployment.storage.authentication.storageAccountConnectionStringName == "AzureWebJobsStorage"
    )
    error_message = "Flex deployment storage must use the runtime account blob endpoint and AzureWebJobsStorage connection-string authentication."
  }

  assert {
    condition     = output.function_app_default_hostname == "test.example.com"
    error_message = "The stamp module must export the Function App default hostname for backend linking."
  }
}

run "no_plaintext_secrets_in_plan" {
  command = plan

  providers = {
    azapi  = azapi.mock
    random = random.mock
  }

  module {
    source = "./tests/unit/stamp-fixture"
  }

  assert {
    condition = (
      !strcontains(jsonencode(azapi_resource.function_app.body.properties.siteConfig.appSettings), "TEST_PT_KEY_SENTINEL") &&
      !strcontains(jsonencode(azapi_resource.function_app.body.properties.siteConfig.appSettings), "TEST_PT_EMAIL@example.test") &&
      !strcontains(jsonencode(azapi_resource.function_app.body.properties.siteConfig.appSettings), "TEST_PT_PASSWORD_SENTINEL") &&
      !strcontains(jsonencode(azapi_resource.function_app.body.properties.siteConfig.appSettings), "TEST_APPINSIGHTS_SENTINEL")
    )
    error_message = "Sensitive sentinel values must not appear in Function App appSettings; Key Vault references should replace them."
  }
}

run "alerts_use_passed_in_app_insights_id" {
  command = plan

  providers = {
    azapi  = azapi.mock
    random = random.mock
  }

  module {
    source = "./tests/unit/stamp-fixture"
  }

  assert {
    condition = (
      azapi_resource.api_5xx_rate.body.properties.scopes == [var.app_insights_id] &&
      azapi_resource.function_execution_failures.body.properties.scopes == [var.app_insights_id] &&
      azapi_resource.auth_lockout_spike.body.properties.scopes == [var.app_insights_id] &&
      azapi_resource.lockround_p95_duration.body.properties.scopes == [var.app_insights_id] &&
      azapi_resource.recompute_marker_stale.body.properties.scopes == [var.app_insights_id] &&
      azapi_resource.blob_heal_storm.body.properties.scopes == [var.app_insights_id] &&
      azapi_resource.storage_server_errors.body.properties.scopes == [azapi_resource.storage_data.id]
    )
    error_message = "All scheduled-query alerts should scope to the passed-in App Insights ID, and the storage metric alert should scope to the data account."
  }
}

run "no_diagnostic_settings" {
  command = plan

  providers = {
    azapi  = azapi.mock
    random = random.mock
  }

  module {
    source = "./tests/unit/stamp-fixture"
  }

  assert {
    condition = length([
      for resource_type in [
        azapi_resource.storage_runtime.type,
        azapi_resource.storage_data.type,
        azapi_update_resource.blob_service_runtime.type,
        azapi_update_resource.blob_service_data.type,
        azapi_resource.storage_container_data.type,
        azapi_resource.storage_container_data_private.type,
        azapi_resource.storage_lifecycle.type,
        azapi_resource.kv.type,
        azapi_resource.kv_admin_role.type,
        azapi_resource.fn_kv_role.type,
        azapi_resource.fn_umi.type,
        azapi_resource.service_plan.type,
        azapi_resource.function_app.type,
        azapi_resource.ops.type,
        azapi_resource.api_5xx_rate.type,
        azapi_resource.function_execution_failures.type,
        azapi_resource.storage_server_errors.type,
        azapi_resource.auth_lockout_spike.type,
        azapi_resource.lockround_p95_duration.type,
        azapi_resource.recompute_marker_stale.type,
        azapi_resource.blob_heal_storm.type,
      ] : resource_type
      if strcontains(resource_type, "Microsoft.Insights/diagnosticSettings")
    ]) == 0
    error_message = "The stamp module must not plan any Microsoft.Insights/diagnosticSettings resources."
  }
}

run "storage_split_staging" {
  command = plan

  providers = {
    azapi  = azapi.mock
    random = random.mock
  }

  module {
    source = "./tests/unit/stamp-fixture"
  }

  assert {
    condition = (
      azapi_resource.storage_runtime.name == "stbccwebunitrt" &&
      azapi_resource.storage_runtime.body.kind == "StorageV2" &&
      azapi_resource.storage_runtime.body.sku.name == "Standard_LRS" &&
      azapi_resource.storage_runtime.body.properties.allowBlobPublicAccess == false &&
      azapi_resource.storage_runtime.body.properties.supportsHttpsTrafficOnly == true &&
      azapi_resource.storage_runtime.body.properties.minimumTlsVersion == "TLS1_2" &&
      azapi_update_resource.blob_service_runtime.resource_id == "${azapi_resource.storage_runtime.id}/blobServices/default" &&
      azapi_resource.storage_container_deploy.name == "deploymentpackage" &&
      azapi_resource.storage_container_deploy.parent_id == "${azapi_resource.storage_runtime.id}/blobServices/default" &&
      azapi_resource.storage_container_deploy.body.properties.publicAccess == "None" &&
      azapi_update_resource.queue_service.type == "Microsoft.Storage/storageAccounts/queueServices@2025-06-01" &&
      azapi_update_resource.queue_service.resource_id == "${azapi_resource.storage_runtime.id}/queueServices/default" &&
      azapi_resource.queue_brief_pdf.name == "round-brief-pdf" &&
      azapi_resource.queue_brief_pdf.type == "Microsoft.Storage/storageAccounts/queueServices/queues@2025-06-01" &&
      azapi_resource.queue_brief_pdf_poison.name == "round-brief-pdf-poison" &&
      azapi_resource.queue_brief_pdf_poison.type == "Microsoft.Storage/storageAccounts/queueServices/queues@2025-06-01" &&
      azapi_resource.queue_brief_pdf.parent_id == "${azapi_resource.storage_runtime.id}/queueServices/default" &&
      azapi_resource.queue_brief_pdf_poison.parent_id == "${azapi_resource.storage_runtime.id}/queueServices/default" &&
      azapi_resource.queue_signtofly_reflect.name == "signtofly-reflect" &&
      azapi_resource.queue_signtofly_reflect.type == "Microsoft.Storage/storageAccounts/queueServices/queues@2025-06-01" &&
      azapi_resource.queue_signtofly_reflect_poison.name == "signtofly-reflect-poison" &&
      azapi_resource.queue_signtofly_reflect_poison.type == "Microsoft.Storage/storageAccounts/queueServices/queues@2025-06-01" &&
      azapi_resource.queue_signtofly_reflect.parent_id == "${azapi_resource.storage_runtime.id}/queueServices/default" &&
      azapi_resource.queue_signtofly_reflect_poison.parent_id == "${azapi_resource.storage_runtime.id}/queueServices/default"
    )
    error_message = "The runtime account must be private, always LRS, and own deploymentpackage plus the round-brief and sign-to-fly queues."
  }

  assert {
    condition = (
      azapi_resource.queue_rescore_jobs.name == "rescore-jobs" &&
      azapi_resource.queue_rescore_jobs.type == "Microsoft.Storage/storageAccounts/queueServices/queues@2025-06-01" &&
      azapi_resource.queue_rescore_jobs.parent_id == "${azapi_resource.storage_runtime.id}/queueServices/default" &&
      azapi_resource.queue_rescore_jobs_poison.name == "rescore-jobs-poison" &&
      azapi_resource.queue_rescore_jobs_poison.type == "Microsoft.Storage/storageAccounts/queueServices/queues@2025-06-01" &&
      azapi_resource.queue_rescore_jobs_poison.parent_id == "${azapi_resource.storage_runtime.id}/queueServices/default"
    )
    error_message = "The rescore-jobs queue and its poison queue must plan under the queue service with the exact expected names, types, and parent linkage."
  }

  assert {
    condition = (
      azapi_resource.queue_puretrack_group.name == "round-puretrack-group" &&
      azapi_resource.queue_puretrack_group.type == "Microsoft.Storage/storageAccounts/queueServices/queues@2025-06-01" &&
      azapi_resource.queue_puretrack_group.parent_id == "${azapi_resource.storage_runtime.id}/queueServices/default" &&
      azapi_resource.queue_puretrack_group_poison.name == "round-puretrack-group-poison" &&
      azapi_resource.queue_puretrack_group_poison.type == "Microsoft.Storage/storageAccounts/queueServices/queues@2025-06-01" &&
      azapi_resource.queue_puretrack_group_poison.parent_id == "${azapi_resource.storage_runtime.id}/queueServices/default"
    )
    error_message = "The round-puretrack-group queue and its poison queue must plan under the queue service with the exact expected names, types, and parent linkage."
  }

  assert {
    condition = (
      azapi_resource.queue_igc_validation.name == "igc-validation" &&
      azapi_resource.queue_igc_validation.type == "Microsoft.Storage/storageAccounts/queueServices/queues@2025-06-01" &&
      azapi_resource.queue_igc_validation.parent_id == "${azapi_resource.storage_runtime.id}/queueServices/default" &&
      azapi_resource.queue_igc_validation_poison.name == "igc-validation-poison" &&
      azapi_resource.queue_igc_validation_poison.type == "Microsoft.Storage/storageAccounts/queueServices/queues@2025-06-01" &&
      azapi_resource.queue_igc_validation_poison.parent_id == "${azapi_resource.storage_runtime.id}/queueServices/default"
    )
    error_message = "The igc-validation queue and its poison queue must plan under the queue service with the exact expected names, types, and parent linkage."
  }

  assert {
    condition = (
      azapi_resource.storage_data.name == "stbccwebunitdata" &&
      azapi_resource.storage_data.body.kind == "StorageV2" &&
      azapi_resource.storage_data.body.sku.name == var.storage_sku &&
      azapi_resource.storage_data.body.properties.allowBlobPublicAccess == true &&
      azapi_update_resource.blob_service_data.resource_id == "${azapi_resource.storage_data.id}/blobServices/default" &&
      azapi_update_resource.blob_service_data.body.properties.isVersioningEnabled == true &&
      azapi_update_resource.blob_service_data.body.properties.changeFeed.enabled == true &&
      azapi_update_resource.blob_service_data.body.properties.deleteRetentionPolicy.days == 7 &&
      azapi_update_resource.blob_service_data.body.properties.containerDeleteRetentionPolicy.days == 7 &&
      length(azapi_update_resource.blob_service_data.body.properties.cors.corsRules) == 1 &&
      azapi_update_resource.blob_service_data.body.properties.cors.corsRules[0].allowedOrigins == var.allowed_origins &&
      azapi_update_resource.blob_service_data.body.properties.cors.corsRules[0].allowedMethods == ["GET", "HEAD", "OPTIONS"] &&
      azapi_update_resource.blob_service_data.body.properties.cors.corsRules[0].allowedHeaders == ["Content-Type", "Authorization", "x-ms-version", "x-ms-date", "x-ms-blob-type", "If-Match", "If-None-Match", "If-Modified-Since", "Range"] &&
      azapi_update_resource.blob_service_data.body.properties.cors.corsRules[0].exposedHeaders == ["x-ms-request-id", "x-ms-version", "Content-Length", "Content-Type", "ETag", "Last-Modified"] &&
      azapi_update_resource.blob_service_data.body.properties.cors.corsRules[0].maxAgeInSeconds == 3600 &&
      azapi_resource.storage_container_data.name == "data" &&
      azapi_resource.storage_container_data.parent_id == "${azapi_resource.storage_data.id}/blobServices/default" &&
      azapi_resource.storage_container_data.body.properties.publicAccess == "Blob" &&
      azapi_resource.storage_container_data_private.name == "data-private" &&
      azapi_resource.storage_container_data_private.parent_id == "${azapi_resource.storage_data.id}/blobServices/default" &&
      azapi_resource.storage_container_data_private.body.properties.publicAccess == "None" &&
      azapi_resource.storage_lifecycle.parent_id == azapi_resource.storage_data.id &&
      length(azapi_resource.storage_lock) == 0 &&
      length(azapi_resource.storage_lifecycle.body.properties.policy.rules) == 2 &&
      azapi_resource.storage_lifecycle.body.properties.policy.rules[0].name == "gc-auth-tokens" &&
      azapi_resource.storage_lifecycle.body.properties.policy.rules[1].name == "gc-rescore-status" &&
      azapi_resource.storage_lifecycle.body.properties.policy.rules[1].definition.filters.prefixMatch == ["data-private/rescore-jobs/"] &&
      azapi_resource.storage_lifecycle.body.properties.policy.rules[1].definition.actions.baseBlob.delete.daysAfterModificationGreaterThan == 7
    )
    error_message = "The staging data account must be public-access enabled, LRS, unlocked, and own the full blob policy, both data containers, and lifecycle rules."
  }

  assert {
    condition = (
      output.storage_account_name_runtime == "stbccwebunitrt" &&
      output.storage_account_name_data == "stbccwebunitdata"
    )
    error_message = "The stamp module must export distinct runtime and data storage account names."
  }
}

run "storage_empty_allowed_origins_disables_cors" {
  command = plan

  providers = {
    azapi  = azapi.mock
    random = random.mock
  }

  module {
    source = "./tests/unit/stamp-fixture"
  }

  variables {
    allowed_origins = []
  }

  assert {
    condition     = length(azapi_update_resource.blob_service_data.body.properties.cors.corsRules) == 0
    error_message = "An empty allowed_origins list must disable Blob Storage CORS instead of emitting an invalid empty-origin rule."
  }
}

run "storage_split_prod" {
  command = plan

  providers = {
    azapi  = azapi.mock
    random = random.mock
  }

  module {
    source = "./tests/unit/stamp-fixture"
  }

  variables {
    stamp_name         = "prod"
    storage_sku        = "Standard_GRS"
    enable_delete_lock = true
  }

  assert {
    condition = (
      azapi_resource.storage_runtime.body.sku.name == "Standard_LRS" &&
      azapi_resource.storage_runtime.body.properties.allowBlobPublicAccess == false &&
      length(azapi_resource.storage_lock) == 1 &&
      azapi_resource.storage_lock[0].parent_id == azapi_resource.storage_data.id &&
      azapi_resource.storage_lock[0].body.properties.level == "CanNotDelete" &&
      azapi_resource.storage_data.body.sku.name == "Standard_GRS" &&
      azapi_resource.storage_data.body.properties.allowBlobPublicAccess == true
    )
    error_message = "Production must keep runtime storage LRS and unlocked while data storage is GRS with a CanNotDelete lock."
  }
}

run "storage_names_reject_over_24_characters" {
  command = plan

  providers = {
    azapi  = azapi.mock
    random = random.mock
  }

  module {
    source = "./tests/unit/stamp-fixture"
  }

  variables {
    stamp_name = "this-stamp-name-is-way-too-long"
  }

  expect_failures = [
    azapi_resource.storage_runtime,
    azapi_resource.storage_data,
  ]
}

run "identity_storage_uses_managed_identity_without_keys" {
  command = plan

  providers = {
    azapi  = azapi.mock
    random = random.mock
  }

  module {
    source = "./tests/unit/stamp-fixture"
  }

  variables {
    use_identity_storage    = true
    allow_shared_key_access = false
  }

  assert {
    condition = (
      length(azapi_resource_action.storage_runtime_keys_legacy) == 0 &&
      length(azapi_resource_action.storage_data_keys_legacy) == 0 &&
      length([for setting in azapi_resource.function_app.body.properties.siteConfig.appSettings : setting if contains(["AzureWebJobsStorage", "BLOB_CONNECTION_STRING"], setting.name)]) == 0 &&
      !strcontains(jsonencode([for setting in azapi_resource.function_app.body.properties.siteConfig.appSettings : setting if contains(["AzureWebJobsStorage__accountName", "AzureWebJobsStorage__credential", "AzureWebJobsStorage__clientId", "BLOB_STORAGE_ACCOUNT_NAME", "STORAGE_UMI_CLIENT_ID"], setting.name)]), "AccountKey=") &&
      !strcontains(jsonencode([for setting in azapi_resource.function_app.body.properties.siteConfig.appSettings : setting if contains(["AzureWebJobsStorage__accountName", "AzureWebJobsStorage__credential", "AzureWebJobsStorage__clientId", "BLOB_STORAGE_ACCOUNT_NAME", "STORAGE_UMI_CLIENT_ID"], setting.name)]), "TEST_STORAGE_KEY_SENTINEL")
    )
    error_message = "Identity storage mode must omit both listKeys actions, both literal connection-string settings, and every account-key value."
  }

  assert {
    condition = (
      one([for setting in azapi_resource.function_app.body.properties.siteConfig.appSettings : setting.value if setting.name == "AzureWebJobsStorage__accountName"]) == "stbccwebunitrt" &&
      one([for setting in azapi_resource.function_app.body.properties.siteConfig.appSettings : setting.value if setting.name == "AzureWebJobsStorage__credential"]) == "managedidentity" &&
      one([for setting in azapi_resource.function_app.body.properties.siteConfig.appSettings : setting.value if setting.name == "AzureWebJobsStorage__clientId"]) == "00000000-0000-0000-0000-000000000001" &&
      one([for setting in azapi_resource.function_app.body.properties.siteConfig.appSettings : setting.value if setting.name == "BLOB_STORAGE_ACCOUNT_NAME"]) == "stbccwebunitdata" &&
      one([for setting in azapi_resource.function_app.body.properties.siteConfig.appSettings : setting.value if setting.name == "STORAGE_UMI_CLIENT_ID"]) == "00000000-0000-0000-0000-000000000001" &&
      one([for setting in azapi_resource.function_app.body.properties.siteConfig.appSettings : setting.value if setting.name == "BLOB_CONTAINER_NAME"]) == "data" &&
      one([for setting in azapi_resource.function_app.body.properties.siteConfig.appSettings : setting.value if setting.name == "BLOB_PRIVATE_CONTAINER_NAME"]) == "data-private"
    )
    error_message = "Identity storage mode must publish the runtime/data account names and the Function UMI client ID while retaining both container names."
  }

  assert {
    condition = (
      azapi_resource.function_app.body.properties.functionAppConfig.deployment.storage.authentication.type == "UserAssignedIdentity" &&
      azapi_resource.function_app.body.properties.functionAppConfig.deployment.storage.authentication.userAssignedIdentityResourceId == azapi_resource.fn_umi.id &&
      !can(azapi_resource.function_app.body.properties.functionAppConfig.deployment.storage.authentication.storageAccountConnectionStringName)
    )
    error_message = "Identity storage mode must authenticate Flex deployment storage with the Function user-assigned identity only."
  }

  assert {
    condition = (
      azapi_resource.storage_runtime.name == "stbccwebunitrt" &&
      azapi_resource.storage_data.name == "stbccwebunitdata" &&
      azapi_resource.storage_runtime.body.properties.allowSharedKeyAccess == false &&
      azapi_resource.storage_data.body.properties.allowSharedKeyAccess == false
    )
    error_message = "Identity mode must preserve the two-account topology and apply the disabled Shared Key policy to both accounts."
  }

  assert {
    condition = (
      length(azapi_resource.fn_runtime_blob_owner_role) == 1 &&
      azapi_resource.fn_runtime_blob_owner_role[0].type == "Microsoft.Authorization/roleAssignments@2022-04-01" &&
      azapi_resource.fn_runtime_blob_owner_role[0].parent_id == azapi_resource.storage_runtime.id &&
      azapi_resource.fn_runtime_blob_owner_role[0].body.properties.roleDefinitionId == "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleDefinitions/b7e6dc6d-f1e8-4753-8033-0f276bb0955b" &&
      azapi_resource.fn_runtime_blob_owner_role[0].body.properties.principalId == azapi_resource.fn_umi.output.properties.principalId &&
      azapi_resource.fn_runtime_blob_owner_role[0].body.properties.principalType == "ServicePrincipal" &&
      length(azapi_resource.fn_runtime_queue_contributor_role) == 1 &&
      azapi_resource.fn_runtime_queue_contributor_role[0].parent_id == azapi_resource.storage_runtime.id &&
      azapi_resource.fn_runtime_queue_contributor_role[0].body.properties.roleDefinitionId == "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleDefinitions/974c5e8b-45b9-4653-ba55-5f855dd0fb88" &&
      azapi_resource.fn_runtime_queue_contributor_role[0].body.properties.principalId == azapi_resource.fn_umi.output.properties.principalId &&
      azapi_resource.fn_runtime_queue_contributor_role[0].body.properties.principalType == "ServicePrincipal" &&
      length(azapi_resource.fn_runtime_table_contributor_role) == 1 &&
      azapi_resource.fn_runtime_table_contributor_role[0].parent_id == azapi_resource.storage_runtime.id &&
      azapi_resource.fn_runtime_table_contributor_role[0].body.properties.roleDefinitionId == "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleDefinitions/0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3" &&
      azapi_resource.fn_runtime_table_contributor_role[0].body.properties.principalId == azapi_resource.fn_umi.output.properties.principalId &&
      azapi_resource.fn_runtime_table_contributor_role[0].body.properties.principalType == "ServicePrincipal" &&
      length(azapi_resource.fn_data_blob_contributor_role) == 1 &&
      azapi_resource.fn_data_blob_contributor_role[0].parent_id == azapi_resource.storage_data.id &&
      azapi_resource.fn_data_blob_contributor_role[0].body.properties.roleDefinitionId == "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleDefinitions/ba92f5b4-2d11-453d-a403-e96b0029c9fe" &&
      azapi_resource.fn_data_blob_contributor_role[0].body.properties.principalId == azapi_resource.fn_umi.output.properties.principalId &&
      azapi_resource.fn_data_blob_contributor_role[0].body.properties.principalType == "ServicePrincipal"
    )
    error_message = "Identity mode must grant the Function UMI the exact runtime Blob Owner, Queue Contributor, Table Contributor, and data Blob Contributor roles at account scope."
  }

  assert {
    condition = (
      length(azapi_resource.operator_runtime_queue_contributor_role) == 0 &&
      length(azapi_resource.operator_deployment_blob_contributor_role) == 0 &&
      length(azapi_resource.operator_data_blob_contributor_role) == 0
    )
    error_message = "The default-empty operator principal must create no operator role assignments."
  }
}

run "identity_storage_grants_operator_data_plane_roles" {
  command = plan

  providers = {
    azapi  = azapi.mock
    random = random.mock
  }

  module {
    source = "./tests/unit/stamp-fixture"
  }

  variables {
    use_identity_storage  = true
    operator_principal_id = "00000000-0000-0000-0000-000000000006"
  }

  assert {
    condition = (
      length(azapi_resource.operator_runtime_queue_contributor_role) == 1 &&
      azapi_resource.operator_runtime_queue_contributor_role[0].type == "Microsoft.Authorization/roleAssignments@2022-04-01" &&
      azapi_resource.operator_runtime_queue_contributor_role[0].parent_id == azapi_resource.storage_runtime.id &&
      azapi_resource.operator_runtime_queue_contributor_role[0].body.properties.roleDefinitionId == "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleDefinitions/974c5e8b-45b9-4653-ba55-5f855dd0fb88" &&
      azapi_resource.operator_runtime_queue_contributor_role[0].body.properties.principalId == "00000000-0000-0000-0000-000000000006" &&
      azapi_resource.operator_runtime_queue_contributor_role[0].body.properties.principalType == "ServicePrincipal" &&
      length(azapi_resource.operator_deployment_blob_contributor_role) == 1 &&
      azapi_resource.operator_deployment_blob_contributor_role[0].parent_id == azapi_resource.storage_container_deploy.id &&
      azapi_resource.operator_deployment_blob_contributor_role[0].body.properties.roleDefinitionId == "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleDefinitions/ba92f5b4-2d11-453d-a403-e96b0029c9fe" &&
      azapi_resource.operator_deployment_blob_contributor_role[0].body.properties.principalId == "00000000-0000-0000-0000-000000000006" &&
      azapi_resource.operator_deployment_blob_contributor_role[0].body.properties.principalType == "ServicePrincipal" &&
      length(azapi_resource.operator_data_blob_contributor_role) == 1 &&
      azapi_resource.operator_data_blob_contributor_role[0].parent_id == azapi_resource.storage_data.id &&
      azapi_resource.operator_data_blob_contributor_role[0].body.properties.roleDefinitionId == "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleDefinitions/ba92f5b4-2d11-453d-a403-e96b0029c9fe" &&
      azapi_resource.operator_data_blob_contributor_role[0].body.properties.principalId == "00000000-0000-0000-0000-000000000006" &&
      azapi_resource.operator_data_blob_contributor_role[0].body.properties.principalType == "ServicePrincipal"
    )
    error_message = "A non-empty operator principal must receive only the exact runtime Queue Contributor, deployment-container Blob Contributor, and data-account Blob Contributor roles."
  }
}

run "legacy_storage_defaults_remain_key_based" {
  command = plan

  providers = {
    azapi  = azapi.mock
    random = random.mock
  }

  module {
    source = "./tests/unit/stamp-fixture"
  }

  assert {
    condition = (
      azapi_resource.storage_runtime.body.properties.allowSharedKeyAccess == true &&
      azapi_resource.storage_data.body.properties.allowSharedKeyAccess == true &&
      length(azapi_resource_action.storage_runtime_keys_legacy) == 1 &&
      length(azapi_resource_action.storage_data_keys_legacy) == 1 &&
      one([for setting in azapi_resource.function_app.body.properties.siteConfig.appSettings : setting.value if setting.name == "AzureWebJobsStorage"]) == "DefaultEndpointsProtocol=https;AccountName=stbccwebunitrt;AccountKey=TEST_STORAGE_KEY_SENTINEL;EndpointSuffix=core.windows.net" &&
      one([for setting in azapi_resource.function_app.body.properties.siteConfig.appSettings : setting.value if setting.name == "BLOB_CONNECTION_STRING"]) == "DefaultEndpointsProtocol=https;AccountName=stbccwebunitdata;AccountKey=TEST_STORAGE_KEY_SENTINEL;EndpointSuffix=core.windows.net" &&
      azapi_resource.function_app.body.properties.functionAppConfig.deployment.storage.authentication.type == "StorageAccountConnectionString" &&
      azapi_resource.function_app.body.properties.functionAppConfig.deployment.storage.authentication.storageAccountConnectionStringName == "AzureWebJobsStorage"
    )
    error_message = "Default legacy mode must retain Shared Key access, both gated listKeys actions and connection strings, and Flex connection-string deployment authentication."
  }

  assert {
    condition = (
      length(azapi_resource.fn_runtime_blob_owner_role) == 0 &&
      length(azapi_resource.fn_runtime_queue_contributor_role) == 0 &&
      length(azapi_resource.fn_runtime_table_contributor_role) == 0 &&
      length(azapi_resource.fn_data_blob_contributor_role) == 0 &&
      length(azapi_resource.operator_runtime_queue_contributor_role) == 0 &&
      length(azapi_resource.operator_deployment_blob_contributor_role) == 0 &&
      length(azapi_resource.operator_data_blob_contributor_role) == 0
    )
    error_message = "Default legacy mode must plan no new storage data-plane role assignments."
  }
}
