# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0

locals {
  monitoring_reader_role_definition_id = "/subscriptions/${local.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/43d0d8ad-25c7-4714-9337-8ba259a9fe05"
  contributor_role_definition_id       = "/subscriptions/${local.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/b24988ac-6180-42a0-ab88-20f7382dd24c"
  application_umi_principal_ids = {
    for env, principal_id in var.env_umi_principal_ids : env => principal_id
    if contains(var.environments, env)
  }
}

output "env_umi_principal_ids" {
  description = "Terraform UMI principal IDs keyed by environment."
  value       = var.env_umi_principal_ids
}

resource "azapi_resource" "env_ai_monitoring_reader" {
  for_each = local.application_umi_principal_ids

  type      = "Microsoft.Authorization/roleAssignments@2022-04-01"
  name      = uuidv5("url", "bccweb-shared-${each.key}-monitoring-reader-${azapi_resource.ai[each.key].id}-${each.value}")
  parent_id = azapi_resource.ai[each.key].id

  body = {
    properties = {
      roleDefinitionId = local.monitoring_reader_role_definition_id
      principalId      = each.value
      principalType    = "ServicePrincipal"
    }
  }
}

# Contributor is intentionally scoped to this single ACS resource: it permits
# communicationServices/listKeys/action, for which Azure has no built-in key-reader role.
resource "azapi_resource" "env_acs_contributor" {
  for_each = local.application_umi_principal_ids

  type      = "Microsoft.Authorization/roleAssignments@2022-04-01"
  name      = uuidv5("url", "bccweb-shared-${each.key}-acs-contributor-${azapi_resource.acs.id}-${each.value}")
  parent_id = azapi_resource.acs.id

  body = {
    properties = {
      roleDefinitionId = local.contributor_role_definition_id
      principalId      = each.value
      principalType    = "ServicePrincipal"
    }
  }
}

resource "azapi_resource" "env_swa_contributor" {
  for_each = local.application_umi_principal_ids

  type      = "Microsoft.Authorization/roleAssignments@2022-04-01"
  name      = uuidv5("url", "bccweb-shared-${each.key}-swa-contributor-${azapi_resource.swa.id}-${each.value}")
  parent_id = azapi_resource.swa.id

  body = {
    properties = {
      roleDefinitionId = local.contributor_role_definition_id
      principalId      = each.value
      principalType    = "ServicePrincipal"
    }
  }
}
