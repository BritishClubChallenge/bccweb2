# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
# Service stack root assembly. Run: terraform -chdir=iac/environment init -backend-config=../env/<env>.backend.hcl && terraform -chdir=iac/environment apply -var-file=../env/<env>.tfvars
#
data "azapi_client_config" "current" {}

data "terraform_remote_state" "shared" {
  backend = "azurerm"

  config = {
    resource_group_name  = var.tfstate_resource_group_name
    storage_account_name = var.tfstate_storage_account_name
    container_name       = "tfstate-shared"
    key                  = "shared.tfstate"
    use_azuread_auth     = true
  }
}

locals {
  is_prod            = var.stamp_name == "prod"
  storage_sku        = local.is_prod ? "Standard_GRS" : "Standard_LRS"
  enable_delete_lock = local.is_prod
  always_ready_count = var.stamp_name == "prod" ? 1 : 0
}

# ─── Stamp module (single instance — single-stamp by user decision) ───────────

module "stamp" {
  source = "./modules/stamp"

  stamp_name            = var.stamp_name
  stamp_rg_name         = var.stamp_rg_name
  location              = var.location
  app_url               = var.app_url
  allowed_origins       = var.allowed_origins
  operator_principal_id = data.terraform_remote_state.shared.outputs.env_umi_principal_ids[var.stamp_name]
  storage_sku           = local.storage_sku
  enable_delete_lock    = local.enable_delete_lock
  always_ready_count    = local.always_ready_count
  ops_email             = var.ops_email
  slack_webhook_url     = var.slack_webhook_url
  acs_id                = data.terraform_remote_state.shared.outputs.acs_id
  acs_sender_address    = data.terraform_remote_state.shared.outputs.acs_sender_address
  puretrack_api_key     = var.puretrack_api_key
  puretrack_email       = var.puretrack_email
  puretrack_password    = var.puretrack_password
  jwt_secret_version    = var.jwt_secret_version
  acs_secret_version    = var.acs_secret_version
  blob_schema_mode      = var.blob_schema_mode
  tags                  = local.tags

  app_insights_id               = data.terraform_remote_state.shared.outputs.app_insights_ids[var.stamp_name]
  terraform_principal_object_id = data.azapi_client_config.current.object_id
  terraform_principal_type      = var.terraform_principal_type
}
