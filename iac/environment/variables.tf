# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
# Root inputs flow into the stamp module and shared-state lookup in main.tf. Per-env values live in ../env/<env>.tfvars.

variable "stamp_name" {
  description = "Environment/stamp name used as the suffix in resource names."
  type        = string
  nullable    = false
}

variable "tfstate_resource_group_name" {
  description = "Resource group containing the canonical Terraform state storage account."
  type        = string
  nullable    = false

  validation {
    condition     = trimspace(var.tfstate_resource_group_name) != ""
    error_message = "tfstate_resource_group_name must not be empty or whitespace."
  }
}

variable "tfstate_storage_account_name" {
  description = "Name of the canonical Terraform state storage account."
  type        = string
  nullable    = false

  validation {
    condition     = trimspace(var.tfstate_storage_account_name) != ""
    error_message = "tfstate_storage_account_name must not be empty or whitespace."
  }
}

variable "stamp_rg_name" {
  description = "Name of the pre-created stamp resource group."
  type        = string
  nullable    = false

  validation {
    condition     = trimspace(var.stamp_rg_name) != ""
    error_message = "stamp_rg_name must not be empty or whitespace."
  }
}

variable "tags" {
  description = "Additional tags merged with the canonical project tags."
  type        = map(string)
  default     = {}
}

variable "terraform_principal_type" {
  description = "Principal type for the identity running Terraform (ServicePrincipal for CI OIDC UMIs; User for local az login applies)."
  type        = string
  default     = "ServicePrincipal"

  validation {
    condition     = contains(["User", "ServicePrincipal"], var.terraform_principal_type)
    error_message = "terraform_principal_type must be either \"User\" or \"ServicePrincipal\"."
  }
}

variable "location" {
  description = "Azure region for the deployment."
  type        = string
  default     = "swedencentral"
}

variable "allowed_origins" {
  description = "Allowed CORS origins for the storage blob service."
  type        = list(string)
  default     = []
}

variable "ops_email" {
  description = "Alert recipient email address."
  type        = string
  nullable    = false

  validation {
    condition     = trimspace(var.ops_email) != ""
    error_message = "ops_email must not be empty or whitespace."
  }
}

variable "slack_webhook_url" {
  description = "Optional Slack webhook URL for alerts."
  type        = string
  default     = ""
}

variable "puretrack_api_key" {
  description = "PureTrack API key."
  type        = string
  sensitive   = true
  nullable    = false

  validation {
    condition     = trimspace(var.puretrack_api_key) != ""
    error_message = "puretrack_api_key must not be empty or whitespace."
  }
}

variable "puretrack_email" {
  description = "PureTrack login email."
  type        = string
  sensitive   = true
  nullable    = false

  validation {
    condition     = trimspace(var.puretrack_email) != ""
    error_message = "puretrack_email must not be empty or whitespace."
  }
}

variable "puretrack_password" {
  description = "PureTrack login password."
  type        = string
  sensitive   = true
  nullable    = false

  validation {
    condition     = trimspace(var.puretrack_password) != ""
    error_message = "puretrack_password must not be empty or whitespace."
  }
}

variable "jwt_secret_version" {
  description = "Rotation trigger for the JWT secret copy in Key Vault."
  type        = string
  default     = "1"
}

variable "acs_secret_version" {
  description = "Rotation trigger for the ACS connection-string copy in Key Vault."
  type        = string
  default     = "1"
}

variable "blob_schema_mode" {
  description = "Blob schema mode for public/private JSON writes."
  type        = string
  default     = "observe"

  validation {
    condition     = contains(["observe", "enforce"], var.blob_schema_mode)
    error_message = "blob_schema_mode must be either \"observe\" or \"enforce\"."
  }
}

locals {
  prefix = "bccweb-${var.stamp_name}"
  tags = merge(var.tags, {
    project     = "bccweb"
    environment = var.stamp_name
    managed_by  = "terraform"
  })
}
