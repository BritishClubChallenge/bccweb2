# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
locals {
  function_app_settings = [
    { name = "AzureWebJobsStorage__accountName", value = local.storage_account_name_runtime },
    { name = "AzureWebJobsStorage__credential", value = "managedidentity" },
    { name = "AzureWebJobsStorage__clientId", value = azapi_resource.fn_umi.output.properties.clientId },
    { name = "BLOB_STORAGE_ACCOUNT_NAME", value = local.storage_account_name_data },
    { name = "RUNTIME_STORAGE_ACCOUNT_NAME", value = local.storage_account_name_runtime },
    { name = "STORAGE_UMI_CLIENT_ID", value = azapi_resource.fn_umi.output.properties.clientId },
    { name = "FUNCTIONS_NODE_BLOCK_ON_ENTRY_POINT_ERROR", value = "true" },
    { name = "BLOB_CONTAINER_NAME", value = "data" },
    { name = "BLOB_PRIVATE_CONTAINER_NAME", value = "data-private" },
    { name = "BLOB_SCHEMA_MODE", value = var.blob_schema_mode },
    { name = "APP_URL", value = var.app_url },
    { name = "JWT_SECRET", value = "@Microsoft.KeyVault(SecretUri=${azapi_resource.kv.output.properties.vaultUri}secrets/jwt-secret/)" },
    { name = "ACS_CONNECTION_STRING", value = "@Microsoft.KeyVault(SecretUri=${azapi_resource.kv.output.properties.vaultUri}secrets/acs-connection-string/)" },
    { name = "APPLICATIONINSIGHTS_CONNECTION_STRING", value = "@Microsoft.KeyVault(SecretUri=${azapi_resource.kv.output.properties.vaultUri}secrets/appinsights-connection-string/)" },
    { name = "ACS_SENDER_ADDRESS", value = var.acs_sender_address },
    { name = "PURETRACK_API_KEY", value = "@Microsoft.KeyVault(SecretUri=${azapi_resource.kv.output.properties.vaultUri}secrets/puretrack-api-key/)" },
    { name = "PURETRACK_EMAIL", value = "@Microsoft.KeyVault(SecretUri=${azapi_resource.kv.output.properties.vaultUri}secrets/puretrack-email/)" },
    { name = "PURETRACK_PASSWORD", value = "@Microsoft.KeyVault(SecretUri=${azapi_resource.kv.output.properties.vaultUri}secrets/puretrack-password/)" },
    { name = "FAI_VALI_ENABLED", value = "true" },
    { name = "FAI_VALI_BASE_URL", value = "https://vali.fai-civl.org" },
    { name = "FAI_VALI_TIMEOUT_MS", value = "20000" },
  ]
}

resource "azapi_resource" "fn_umi" {
  type      = "Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31"
  name      = "id-bccweb-${var.stamp_name}-fn"
  parent_id = local.stamp_rg_id
  location  = var.location
  tags      = var.tags

  body = {}

  response_export_values = ["id", "properties.principalId", "properties.clientId"]
}

resource "azapi_resource" "service_plan" {
  type      = "Microsoft.Web/serverfarms@2024-04-01"
  name      = "asp-bccweb-${var.stamp_name}"
  parent_id = local.stamp_rg_id
  location  = var.location
  tags      = var.tags

  body = {
    kind = "functionapp"
    sku = {
      name = "FC1"
      tier = "FlexConsumption"
    }
    properties = {
      reserved = true
    }
  }
}

resource "azapi_resource" "function_app" {
  type      = "Microsoft.Web/sites@2024-04-01"
  name      = "func-bccweb-${var.stamp_name}"
  parent_id = local.stamp_rg_id
  location  = var.location
  tags      = var.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azapi_resource.fn_umi.id]
  }

  body = {
    kind = "functionapp,linux"
    properties = {
      serverFarmId              = azapi_resource.service_plan.id
      httpsOnly                 = true
      keyVaultReferenceIdentity = azapi_resource.fn_umi.id
      siteConfig = {
        appSettings = local.function_app_settings
        cors = {
          allowedOrigins = var.allowed_origins
        }
      }
      functionAppConfig = {
        deployment = {
          storage = {
            type  = "blobContainer"
            value = "${trimsuffix(azapi_resource.storage_runtime.output.properties.primaryEndpoints.blob, "/")}/deploymentpackage"
            authentication = {
              type                           = "UserAssignedIdentity"
              userAssignedIdentityResourceId = azapi_resource.fn_umi.id
            }
          }
        }
        runtime = {
          name    = "node"
          version = "24"
        }
        scaleAndConcurrency = {
          maximumInstanceCount = 100
          instanceMemoryMB     = 2048
          alwaysReady = var.always_ready_count > 0 ? [{
            name          = "http"
            instanceCount = var.always_ready_count
          }] : []
        }
      }
    }
  }

  response_export_values = ["id", "name", "properties.defaultHostName"]

  depends_on = [
    azapi_resource.storage_container_deploy,
    azapi_resource.fn_runtime_blob_owner_role,
    azapi_resource.fn_runtime_queue_contributor_role,
    azapi_resource.fn_runtime_table_contributor_role,
    azapi_resource.fn_data_blob_contributor_role,
    azapi_resource.operator_runtime_queue_contributor_role,
    azapi_resource.operator_deployment_blob_contributor_role,
    azapi_resource.operator_data_blob_contributor_role,
  ]

  lifecycle {
    ignore_changes = [body.properties.siteConfig.cors]
  }
}
