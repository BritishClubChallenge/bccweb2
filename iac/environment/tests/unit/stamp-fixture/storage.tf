# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
locals {
  # Storage account names must be lowercase, contain no hyphens, and be no
  # longer than 24 characters.
  storage_account_name_runtime = replace("stbccweb${var.stamp_name}rt", "-", "")
  storage_account_name_data    = replace("stbccweb${var.stamp_name}data", "-", "")
}

# ─── Runtime Storage Account ─────────────────────────────────────────────────
#
# AzureWebJobsStorage targets this full StorageV2 account. Runtime state, queue
# workloads, and deployment packages are reconstructible, so it is always LRS,
# has no delete lock, and never permits public blob access.

resource "azapi_resource" "storage_runtime" {
  type      = "Microsoft.Storage/storageAccounts@2025-06-01"
  name      = local.storage_account_name_runtime
  parent_id = local.stamp_rg_id
  location  = var.location
  tags      = var.tags

  # Azure omits allowSharedKeyAccess from GET until it is explicitly set, so
  # AzAPI's permissive default would silently discard the configured false.
  ignore_missing_property = false

  body = {
    kind = "StorageV2"
    sku = {
      name = "Standard_LRS"
    }
    properties = {
      allowBlobPublicAccess    = false
      allowSharedKeyAccess     = false
      supportsHttpsTrafficOnly = true
      minimumTlsVersion        = "TLS1_2"
    }
  }

  response_export_values = ["name", "properties.primaryEndpoints.blob"]

  lifecycle {
    precondition {
      condition     = length(local.storage_account_name_runtime) <= 24
      error_message = "Runtime storage account name must not exceed 24 characters."
    }
  }
}

# Azure omits allowSharedKeyAccess from GET until it is explicitly set, so the
# parent body alone can be silently ignored; this update forces the first PUT.
resource "azapi_update_resource" "storage_runtime_shared_key" {
  type        = "Microsoft.Storage/storageAccounts@2025-06-01"
  resource_id = azapi_resource.storage_runtime.id

  body = {
    properties = {
      allowSharedKeyAccess = false
    }
  }

  depends_on = [
    azapi_resource.fn_runtime_blob_owner_role,
    azapi_resource.fn_runtime_queue_contributor_role,
    azapi_resource.fn_runtime_table_contributor_role,
    azapi_resource.fn_data_blob_contributor_role,
    azapi_resource.operator_runtime_queue_contributor_role,
    azapi_resource.operator_deployment_blob_contributor_role,
    azapi_resource.operator_data_blob_contributor_role,
  ]
}

# The runtime blob service intentionally has no versioning, CORS, change feed,
# or soft-delete policy. It exists only for Functions runtime state and the Flex
# deployment package container used by the later Flex migration.
resource "azapi_update_resource" "blob_service_runtime" {
  type        = "Microsoft.Storage/storageAccounts/blobServices@2025-06-01"
  resource_id = "${azapi_resource.storage_runtime.id}/blobServices/default"

  body = {
    properties = {}
  }
}

resource "azapi_resource" "storage_container_deploy" {
  type      = "Microsoft.Storage/storageAccounts/blobServices/containers@2025-06-01"
  name      = "deploymentpackage"
  parent_id = "${azapi_resource.storage_runtime.id}/blobServices/default"

  body = {
    properties = {
      publicAccess = "None"
    }
  }

  depends_on = [azapi_update_resource.blob_service_runtime]
}

# ─── Queue Service ───────────────────────────────────────────────────────────
#
# All queue-triggered Functions and producers use AzureWebJobsStorage, so every
# application queue belongs to the runtime account.

resource "azapi_update_resource" "queue_service" {
  type        = "Microsoft.Storage/storageAccounts/queueServices@2025-06-01"
  resource_id = "${azapi_resource.storage_runtime.id}/queueServices/default"

  body = {
    properties = {}
  }
}

# ─── Round-Brief PDF Queues ──────────────────────────────────────────────────

resource "azapi_resource" "queue_brief_pdf" {
  type       = "Microsoft.Storage/storageAccounts/queueServices/queues@2025-06-01"
  name       = "round-brief-pdf"
  parent_id  = "${azapi_resource.storage_runtime.id}/queueServices/default"
  depends_on = [azapi_update_resource.queue_service]
}

resource "azapi_resource" "queue_brief_pdf_poison" {
  type       = "Microsoft.Storage/storageAccounts/queueServices/queues@2025-06-01"
  name       = "round-brief-pdf-poison"
  parent_id  = "${azapi_resource.storage_runtime.id}/queueServices/default"
  depends_on = [azapi_update_resource.queue_service]
}

# ─── Sign-to-Fly Reflect Queues ──────────────────────────────────────────────

resource "azapi_resource" "queue_signtofly_reflect" {
  type       = "Microsoft.Storage/storageAccounts/queueServices/queues@2025-06-01"
  name       = "signtofly-reflect"
  parent_id  = "${azapi_resource.storage_runtime.id}/queueServices/default"
  depends_on = [azapi_update_resource.queue_service]
}

resource "azapi_resource" "queue_signtofly_reflect_poison" {
  type       = "Microsoft.Storage/storageAccounts/queueServices/queues@2025-06-01"
  name       = "signtofly-reflect-poison"
  parent_id  = "${azapi_resource.storage_runtime.id}/queueServices/default"
  depends_on = [azapi_update_resource.queue_service]
}

# ─── Rescore Jobs Queues ─────────────────────────────────────────────────────

resource "azapi_resource" "queue_rescore_jobs" {
  type       = "Microsoft.Storage/storageAccounts/queueServices/queues@2025-06-01"
  name       = "rescore-jobs"
  parent_id  = "${azapi_resource.storage_runtime.id}/queueServices/default"
  depends_on = [azapi_update_resource.queue_service]
}

resource "azapi_resource" "queue_rescore_jobs_poison" {
  type       = "Microsoft.Storage/storageAccounts/queueServices/queues@2025-06-01"
  name       = "rescore-jobs-poison"
  parent_id  = "${azapi_resource.storage_runtime.id}/queueServices/default"
  depends_on = [azapi_update_resource.queue_service]
}

# ─── IGC Validation Queues ───────────────────────────────────────────────────

resource "azapi_resource" "queue_igc_validation" {
  type       = "Microsoft.Storage/storageAccounts/queueServices/queues@2025-06-01"
  name       = "igc-validation"
  parent_id  = "${azapi_resource.storage_runtime.id}/queueServices/default"
  depends_on = [azapi_update_resource.queue_service]
}

resource "azapi_resource" "queue_igc_validation_poison" {
  type       = "Microsoft.Storage/storageAccounts/queueServices/queues@2025-06-01"
  name       = "igc-validation-poison"
  parent_id  = "${azapi_resource.storage_runtime.id}/queueServices/default"
  depends_on = [azapi_update_resource.queue_service]
}

# ─── PureTrack Group Queues ──────────────────────────────────────────────────

resource "azapi_resource" "queue_puretrack_group" {
  type       = "Microsoft.Storage/storageAccounts/queueServices/queues@2025-06-01"
  name       = "round-puretrack-group"
  parent_id  = "${azapi_resource.storage_runtime.id}/queueServices/default"
  depends_on = [azapi_update_resource.queue_service]
}

resource "azapi_resource" "queue_puretrack_group_poison" {
  type       = "Microsoft.Storage/storageAccounts/queueServices/queues@2025-06-01"
  name       = "round-puretrack-group-poison"
  parent_id  = "${azapi_resource.storage_runtime.id}/queueServices/default"
  depends_on = [azapi_update_resource.queue_service]
}

# ─── Data Storage Account ────────────────────────────────────────────────────
#
resource "azapi_resource" "storage_data" {
  type      = "Microsoft.Storage/storageAccounts@2025-06-01"
  name      = local.storage_account_name_data
  parent_id = local.stamp_rg_id
  location  = var.location
  tags      = var.tags

  # Azure omits allowSharedKeyAccess from GET until it is explicitly set, so
  # AzAPI's permissive default would silently discard the configured false.
  ignore_missing_property = false

  body = {
    kind = "StorageV2"
    sku = {
      name = var.storage_sku
    }
    properties = {
      allowBlobPublicAccess    = true
      allowSharedKeyAccess     = false
      supportsHttpsTrafficOnly = true
      minimumTlsVersion        = "TLS1_2"
    }
  }

  response_export_values = ["name"]

  lifecycle {
    precondition {
      condition     = length(local.storage_account_name_data) <= 24
      error_message = "Data storage account name must not exceed 24 characters."
    }
  }
}

# Azure omits allowSharedKeyAccess from GET until it is explicitly set, so the
# parent body alone can be silently ignored; this update forces the first PUT.
resource "azapi_update_resource" "storage_data_shared_key" {
  type        = "Microsoft.Storage/storageAccounts@2025-06-01"
  resource_id = azapi_resource.storage_data.id

  body = {
    properties = {
      allowSharedKeyAccess = false
    }
  }

  depends_on = [
    azapi_resource.fn_runtime_blob_owner_role,
    azapi_resource.fn_runtime_queue_contributor_role,
    azapi_resource.fn_runtime_table_contributor_role,
    azapi_resource.fn_data_blob_contributor_role,
    azapi_resource.operator_runtime_queue_contributor_role,
    azapi_resource.operator_deployment_blob_contributor_role,
    azapi_resource.operator_data_blob_contributor_role,
  ]
}

# Prevent accidental deletion of production data. Non-production environments
# leave this resource absent so disposable stamps remain easy to tear down.
resource "azapi_resource" "storage_lock" {
  count = var.enable_delete_lock ? 1 : 0

  type      = "Microsoft.Authorization/locks@2020-05-01"
  name      = "storage-nodelete"
  parent_id = azapi_resource.storage_data.id

  body = {
    properties = {
      level = "CanNotDelete"
      notes = "Prevents accidental destroy; remove via deliberate operator action"
    }
  }

  depends_on = [azapi_resource.storage_data]
}

# Versioning, change feed, and soft-delete protect application data. CORS is
# locked to var.allowed_origins (no wildcard).
resource "azapi_update_resource" "blob_service_data" {
  type        = "Microsoft.Storage/storageAccounts/blobServices@2025-06-01"
  resource_id = "${azapi_resource.storage_data.id}/blobServices/default"

  body = {
    properties = {
      isVersioningEnabled = true
      changeFeed = {
        enabled = true
      }
      deleteRetentionPolicy = {
        enabled = true
        days    = 7
      }
      containerDeleteRetentionPolicy = {
        enabled = true
        days    = 7
      }
      cors = {
        corsRules = length(var.allowed_origins) == 0 ? [] : [
          {
            allowedOrigins  = var.allowed_origins
            allowedMethods  = ["GET", "HEAD", "OPTIONS"]
            allowedHeaders  = ["Content-Type", "Authorization", "x-ms-version", "x-ms-date", "x-ms-blob-type", "If-Match", "If-None-Match", "If-Modified-Since", "Range"]
            exposedHeaders  = ["x-ms-request-id", "x-ms-version", "Content-Length", "Content-Type", "ETag", "Last-Modified"]
            maxAgeInSeconds = 3600
          }
        ]
      }
    }
  }
}

resource "azapi_resource" "storage_container_data" {
  type      = "Microsoft.Storage/storageAccounts/blobServices/containers@2025-06-01"
  name      = "data"
  parent_id = "${azapi_resource.storage_data.id}/blobServices/default"

  body = {
    properties = {
      publicAccess = "Blob"
    }
  }
  depends_on = [azapi_update_resource.blob_service_data]
}

resource "azapi_resource" "storage_container_data_private" {
  type      = "Microsoft.Storage/storageAccounts/blobServices/containers@2025-06-01"
  name      = "data-private"
  parent_id = "${azapi_resource.storage_data.id}/blobServices/default"

  body = {
    properties = {
      publicAccess = "None"
    }
  }
  depends_on = [azapi_update_resource.blob_service_data]
}

removed {
  from = azapi_resource_action.storage_runtime_keys

  lifecycle {
    destroy = false
  }
}

removed {
  from = azapi_resource_action.storage_data_keys

  lifecycle {
    destroy = false
  }
}

# ─── Blob Lifecycle Management Policy ────────────────────────────────────────
#
# GC short-lived control blobs from data-private after 7 days.

resource "azapi_resource" "storage_lifecycle" {
  type      = "Microsoft.Storage/storageAccounts/managementPolicies@2023-01-01"
  name      = "default"
  parent_id = azapi_resource.storage_data.id

  body = {
    properties = {
      policy = {
        rules = [
          {
            name    = "gc-auth-tokens"
            enabled = true
            type    = "Lifecycle"
            definition = {
              filters = {
                blobTypes   = ["blockBlob"]
                prefixMatch = ["data-private/auth/tokens/"]
              }
              actions = {
                baseBlob = {
                  delete = {
                    daysAfterModificationGreaterThan = 7
                  }
                }
              }
            }
          },
          {
            name    = "gc-rescore-status"
            enabled = true
            type    = "Lifecycle"
            definition = {
              filters = {
                blobTypes   = ["blockBlob"]
                prefixMatch = ["data-private/rescore-jobs/"]
              }
              actions = {
                baseBlob = {
                  delete = {
                    daysAfterModificationGreaterThan = 7
                  }
                }
              }
            }
          }
        ]
      }
    }
  }

  depends_on = [azapi_update_resource.blob_service_data, azapi_resource.storage_container_data_private]
}
