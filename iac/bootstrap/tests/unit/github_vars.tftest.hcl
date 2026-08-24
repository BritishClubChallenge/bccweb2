# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0

mock_provider "azapi" {
  alias           = "mock"
  override_during = plan

  mock_data "azapi_client_config" {
    defaults = {
      subscription_id = "00000000-0000-0000-0000-000000000000"
      tenant_id       = "00000000-0000-0000-0000-000000000001"
    }
  }

  mock_resource "azapi_resource" {
    defaults = {
      id   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bccweb-unit/providers/Microsoft.Mock/mockResources/mock"
      name = "mock"
      output = {
        properties = {
          clientId    = "00000000-0000-0000-0000-000000000002"
          principalId = "00000000-0000-0000-0000-000000000003"
        }
      }
    }
  }
}

mock_provider "github" {
  alias           = "mock"
  override_during = plan
}

mock_provider "local" {
  alias           = "mock"
  override_during = plan
}

override_resource {
  target          = azapi_resource.tf_umi["prod"]
  override_during = plan
  values = {
    id   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bccweb-unit/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-bccweb-terraform-prod"
    name = "id-bccweb-terraform-prod"
    output = {
      properties = {
        clientId    = "00000000-0000-0000-0000-000000000012"
        principalId = "00000000-0000-0000-0000-000000000013"
      }
    }
  }
}

override_resource {
  target          = azapi_resource.tf_umi["shared"]
  override_during = plan
  values = {
    id   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bccweb-unit/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-bccweb-terraform-shared"
    name = "id-bccweb-terraform-shared"
    output = {
      properties = {
        clientId    = "00000000-0000-0000-0000-000000000022"
        principalId = "00000000-0000-0000-0000-000000000023"
      }
    }
  }
}

override_resource {
  target          = azapi_resource.tf_umi["staging"]
  override_during = plan
  values = {
    id   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bccweb-unit/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-bccweb-terraform-staging"
    name = "id-bccweb-terraform-staging"
    output = {
      properties = {
        clientId    = "00000000-0000-0000-0000-000000000032"
        principalId = "00000000-0000-0000-0000-000000000033"
      }
    }
  }
}

variables {
  manage_github_secrets = true
}

run "canonical_github_variables_and_shared_tfvars_are_generated" {
  command = plan

  providers = {
    azapi  = azapi.mock
    github = github.mock
    local  = local.mock
  }

  assert {
    condition = toset(keys(github_actions_environment_variable.rg_names)) == toset([
      "staging/TF_VAR_STAMP_RG_NAME",
      "staging/AZURE_LOCATION",
      "staging/SHARED_RG_NAME",
      "prod/TF_VAR_STAMP_RG_NAME",
      "prod/AZURE_LOCATION",
      "prod/SHARED_RG_NAME",
    ])
    error_message = "Bootstrap must publish exactly the six application deploy variables, with no missing or extra environment/name pair."
  }

  assert {
    condition = alltrue([
      for key, expected in {
        "staging/TF_VAR_STAMP_RG_NAME" = { environment = "staging", name = "TF_VAR_STAMP_RG_NAME", value = "stamp-staging" }
        "staging/AZURE_LOCATION"       = { environment = "staging", name = "AZURE_LOCATION", value = "swedencentral" }
        "staging/SHARED_RG_NAME"       = { environment = "staging", name = "SHARED_RG_NAME", value = "rg-bccweb-shared" }
        "prod/TF_VAR_STAMP_RG_NAME"    = { environment = "prod", name = "TF_VAR_STAMP_RG_NAME", value = "stamp-prod" }
        "prod/AZURE_LOCATION"          = { environment = "prod", name = "AZURE_LOCATION", value = "swedencentral" }
        "prod/SHARED_RG_NAME"          = { environment = "prod", name = "SHARED_RG_NAME", value = "rg-bccweb-shared" }
        } : (
        github_actions_environment_variable.rg_names[key].environment == expected.environment &&
        github_actions_environment_variable.rg_names[key].variable_name == expected.name &&
        github_actions_environment_variable.rg_names[key].value == expected.value
      )
    ])
    error_message = "Each application environment publication must target its canonical environment, name, and topology value."
  }

  assert {
    condition = alltrue([
      for variable in github_actions_environment_variable.rg_names :
      variable.variable_name != "TF_VAR_env_umi_principal_ids"
    ])
    error_message = "Bootstrap must not publish TF_VAR_env_umi_principal_ids to GitHub."
  }

  assert {
    condition     = local_file.shared_generated_tfvars.filename == "${path.module}/../env/shared.generated.tfvars"
    error_message = "Bootstrap must generate the shared principal-ID tfvars at iac/env/shared.generated.tfvars."
  }

  assert {
    condition     = local_file.shared_generated_tfvars.file_permission == "0644"
    error_message = "The generated shared tfvars must be non-secret, repository-readable mode 0644."
  }

  assert {
    condition     = local_file.shared_generated_tfvars.content == <<-EOT
      # SPDX-FileCopyrightText: 2026 British Club Challenge authors
      # SPDX-License-Identifier: MPL-2.0
      # Generated by iac/bootstrap; non-secret and must be committed after bootstrap apply.

      env_umi_principal_ids = {
        prod    = "00000000-0000-0000-0000-000000000013"
        shared  = "00000000-0000-0000-0000-000000000023"
        staging = "00000000-0000-0000-0000-000000000033"
      }
      EOT
    error_message = "The generated shared tfvars must contain the exact SPDX header, provenance comment, and complete sorted principal-ID map."
  }

  assert {
    condition = alltrue([
      for resource_group in azapi_resource.pre_created_rg :
      resource_group.location == "swedencentral"
    ])
    error_message = "Application workload resource groups must be pre-created in Sweden Central."
  }

  assert {
    condition = alltrue([
      for environment, credential in azapi_resource.tf_umi_fed_cred :
      credential.body.properties.subject == "repo:BritishClubChallenge@318211912/bccweb2@1264013182:environment:${environment}"
    ])
    error_message = "Azure federated credentials must trust GitHub's immutable repository subject claims."
  }
}

run "mismatched_stamp_rg_is_rejected" {
  command = plan

  providers = {
    azapi  = azapi.mock
    github = github.mock
    local  = local.mock
  }

  variables {
    terraform_umis = {
      staging = {
        stamp_rg   = "stamp-staging"
        github_env = "staging"
      }
      prod = {
        stamp_rg   = "stamp-wrong"
        github_env = "prod"
      }
      shared = {
        github_env = "shared"
      }
    }
  }

  expect_failures = [
    var.terraform_umis,
  ]
}

run "partially_immutable_oidc_subject_is_rejected" {
  command = plan

  providers = {
    azapi  = azapi.mock
    github = github.mock
    local  = local.mock
  }

  variables {
    github_repo              = "owner/repository"
    github_oidc_subject_repo = "owner@1/repository"
  }

  expect_failures = [var.github_oidc_subject_repo]
}

run "oidc_subject_repository_mismatch_is_rejected" {
  command = plan

  providers = {
    azapi  = azapi.mock
    github = github.mock
    local  = local.mock
  }

  variables {
    github_repo              = "owner/repository"
    github_oidc_subject_repo = "attacker@1/repository@2"
  }

  expect_failures = [var.github_oidc_subject_repo]
}
