# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
# Required inputs from root: app_insights_id, acs_id,
# terraform_principal_object_id.
#
# This is the stamp module's input schema. The root module declares the same
# user-facing variable names in iac/environment/variables.tf and forwards them into the
# module call (intentional duplicate per Terraform module practice). Plaintext
# secret values (e.g. jwt_secret) MUST NOT be declared here — they are seeded
# into Key Vault out-of-band; rotation triggers are passed as version inputs.

# ─── Forwarded from root ──────────────────────────────────────────────────────

variable "stamp_name" {
  description = "Environment/stamp name used as the suffix in resource names."
  type        = string
  nullable    = false
}

variable "stamp_rg_name" {
  description = "Name of the pre-created stamp resource group (owned by iac/bootstrap; referenced here by interpolated ID)."
  type        = string
  nullable    = false
}

variable "location" {
  description = "Azure region for the deployment."
  type        = string
  nullable    = false
}

variable "allowed_origins" {
  description = "Allowed CORS origins for the storage blob service."
  type        = list(string)
  default     = []
}

variable "use_identity_storage" {
  description = "Whether storage access uses the Function App user-assigned identity instead of account keys."
  type        = bool
  default     = false
}

variable "allow_shared_key_access" {
  description = "Whether both application storage accounts permit Shared Key authorization."
  type        = bool
  default     = true
}

variable "operator_principal_id" {
  description = "Optional staging deployment operator service-principal object ID for storage data-plane access."
  type        = string
  default     = ""
}

variable "storage_sku" {
  description = "Replication SKU for the application data storage account."
  type        = string
  nullable    = false
}

variable "enable_delete_lock" {
  description = "Whether to apply a CanNotDelete management lock to the application data storage account."
  type        = bool
  default     = false
}

variable "always_ready_count" {
  description = "Number of always-ready HTTP instances for the Flex Consumption Function App."
  type        = number
  default     = 0
}

variable "ops_email" {
  description = "Alert recipient email address."
  type        = string
  nullable    = false
}

variable "slack_webhook_url" {
  description = "Optional Slack webhook URL for alerts."
  type        = string
  default     = ""
}

variable "acs_id" {
  description = "Resource ID of the shared Azure Communication Service (REQUIRED INPUT from root)."
  type        = string
  nullable    = false
}

variable "acs_sender_address" {
  description = "Full ACS sender address (e.g. noreply@mail.example.com)."
  type        = string
  nullable    = false
}

variable "puretrack_api_key" {
  description = "PureTrack API key for the BCC account."
  type        = string
  sensitive   = true
  nullable    = false
}

variable "puretrack_email" {
  description = "PureTrack login email for the BCC account."
  type        = string
  sensitive   = true
  nullable    = false
}

variable "puretrack_password" {
  description = "PureTrack login password for the BCC account."
  type        = string
  sensitive   = true
  nullable    = false
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

variable "tags" {
  description = "Tags applied to every resource in the stamp."
  type        = map(string)
  default     = {}
}

# ─── Required inputs from root ────────────────────────────────────────────────
#
# These three are selected by the root module from shared state or the active
# Terraform principal and forwarded into the stamp instance.
# They have no sensible defaults — the module must refuse to plan without them.

variable "app_insights_id" {
  description = "Resource ID of the shared Application Insights component (REQUIRED INPUT from root)."
  type        = string
  nullable    = false
}

variable "terraform_principal_object_id" {
  description = "Object ID of the Terraform-running principal; granted Key Vault Secrets Officer for data-plane writes (REQUIRED INPUT from root)."
  type        = string
  nullable    = false
}

variable "terraform_principal_type" {
  description = "Principal type for the Terraform-running identity (User for local az login; ServicePrincipal for UMI/SP via OIDC or client secret)."
  type        = string
  default     = "ServicePrincipal"

  validation {
    condition     = contains(["User", "ServicePrincipal"], var.terraform_principal_type)
    error_message = "terraform_principal_type must be either \"User\" or \"ServicePrincipal\"."
  }
}
