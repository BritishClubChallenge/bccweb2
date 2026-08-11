# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
locals {
  storage_blob_data_owner_role_id        = "/subscriptions/${data.azapi_client_config.current.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/b7e6dc6d-f1e8-4753-8033-0f276bb0955b"
  storage_blob_data_contributor_role_id  = "/subscriptions/${data.azapi_client_config.current.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/ba92f5b4-2d11-453d-a403-e96b0029c9fe"
  storage_queue_data_contributor_role_id = "/subscriptions/${data.azapi_client_config.current.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/974c5e8b-45b9-4653-ba55-5f855dd0fb88"
  storage_table_data_contributor_role_id = "/subscriptions/${data.azapi_client_config.current.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3"
  operator_storage_role_count            = var.use_identity_storage && var.operator_principal_id != "" ? 1 : 0
}

resource "random_uuid" "fn_runtime_blob_owner" {
  count = var.use_identity_storage ? 1 : 0
}

resource "azapi_resource" "fn_runtime_blob_owner_role" {
  count = var.use_identity_storage ? 1 : 0

  type      = "Microsoft.Authorization/roleAssignments@2022-04-01"
  name      = random_uuid.fn_runtime_blob_owner[0].result
  parent_id = azapi_resource.storage_runtime.id

  body = {
    properties = {
      roleDefinitionId = local.storage_blob_data_owner_role_id
      principalId      = azapi_resource.fn_umi.output.properties.principalId
      principalType    = "ServicePrincipal"
    }
  }
}

resource "random_uuid" "fn_runtime_queue_contributor" {
  count = var.use_identity_storage ? 1 : 0
}

resource "azapi_resource" "fn_runtime_queue_contributor_role" {
  count = var.use_identity_storage ? 1 : 0

  type      = "Microsoft.Authorization/roleAssignments@2022-04-01"
  name      = random_uuid.fn_runtime_queue_contributor[0].result
  parent_id = azapi_resource.storage_runtime.id

  body = {
    properties = {
      roleDefinitionId = local.storage_queue_data_contributor_role_id
      principalId      = azapi_resource.fn_umi.output.properties.principalId
      principalType    = "ServicePrincipal"
    }
  }
}

resource "random_uuid" "fn_runtime_table_contributor" {
  count = var.use_identity_storage ? 1 : 0
}

resource "azapi_resource" "fn_runtime_table_contributor_role" {
  count = var.use_identity_storage ? 1 : 0

  type      = "Microsoft.Authorization/roleAssignments@2022-04-01"
  name      = random_uuid.fn_runtime_table_contributor[0].result
  parent_id = azapi_resource.storage_runtime.id

  body = {
    properties = {
      roleDefinitionId = local.storage_table_data_contributor_role_id
      principalId      = azapi_resource.fn_umi.output.properties.principalId
      principalType    = "ServicePrincipal"
    }
  }
}

resource "random_uuid" "fn_data_blob_contributor" {
  count = var.use_identity_storage ? 1 : 0
}

resource "azapi_resource" "fn_data_blob_contributor_role" {
  count = var.use_identity_storage ? 1 : 0

  type      = "Microsoft.Authorization/roleAssignments@2022-04-01"
  name      = random_uuid.fn_data_blob_contributor[0].result
  parent_id = azapi_resource.storage_data.id

  body = {
    properties = {
      roleDefinitionId = local.storage_blob_data_contributor_role_id
      principalId      = azapi_resource.fn_umi.output.properties.principalId
      principalType    = "ServicePrincipal"
    }
  }
}

resource "random_uuid" "operator_runtime_queue_contributor" {
  count = local.operator_storage_role_count
}

resource "azapi_resource" "operator_runtime_queue_contributor_role" {
  count = local.operator_storage_role_count

  type      = "Microsoft.Authorization/roleAssignments@2022-04-01"
  name      = random_uuid.operator_runtime_queue_contributor[0].result
  parent_id = azapi_resource.storage_runtime.id

  body = {
    properties = {
      roleDefinitionId = local.storage_queue_data_contributor_role_id
      principalId      = var.operator_principal_id
      principalType    = "ServicePrincipal"
    }
  }
}

resource "random_uuid" "operator_deployment_blob_contributor" {
  count = local.operator_storage_role_count
}

resource "azapi_resource" "operator_deployment_blob_contributor_role" {
  count = local.operator_storage_role_count

  type      = "Microsoft.Authorization/roleAssignments@2022-04-01"
  name      = random_uuid.operator_deployment_blob_contributor[0].result
  parent_id = azapi_resource.storage_container_deploy.id

  body = {
    properties = {
      roleDefinitionId = local.storage_blob_data_contributor_role_id
      principalId      = var.operator_principal_id
      principalType    = "ServicePrincipal"
    }
  }
}

resource "random_uuid" "operator_data_blob_contributor" {
  count = local.operator_storage_role_count
}

resource "azapi_resource" "operator_data_blob_contributor_role" {
  count = local.operator_storage_role_count

  type      = "Microsoft.Authorization/roleAssignments@2022-04-01"
  name      = random_uuid.operator_data_blob_contributor[0].result
  parent_id = azapi_resource.storage_data.id

  body = {
    properties = {
      roleDefinitionId = local.storage_blob_data_contributor_role_id
      principalId      = var.operator_principal_id
      principalType    = "ServicePrincipal"
    }
  }
}
