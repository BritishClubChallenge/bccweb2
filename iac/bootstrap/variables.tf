# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
# Inputs for the bccweb2 tfstate bootstrap.
#
# `tfstate_storage_account_name` has no default — Azure storage account
# names must be globally unique, so the operator must supply one (lowercase,
# 3–24 chars, letters and digits only). `terraform_umis` has no default —
# the operator supplies the canonical per-env map via terraform.tfvars
# (see terraform.tfvars.example). The shared entry has no stamp RG; every
# application environment entry names exactly one stamp RG.

variable "location" {
  type        = string
  description = "Azure region for the bootstrap, state, identity, shared, and application resource groups."
  default     = "swedencentral"
}

variable "bootstrap_rg_name" {
  type        = string
  description = "Name of the bootstrap resource group that holds the tfstate storage account."
  default     = "rg-bccweb-tfstate"
}

variable "tfstate_storage_account_name" {
  type        = string
  description = "Globally-unique storage account name (3–24 chars, lowercase letters and digits) that will host the tfstate blob container. Operator must supply."
  nullable    = false

  validation {
    condition     = can(regex("^[a-z0-9]{3,24}$", var.tfstate_storage_account_name))
    error_message = "tfstate_storage_account_name must be 3–24 chars, lowercase letters and digits only."
  }
}

variable "tfstate_container_prefix" {
  type        = string
  description = "Name of the blob container that holds tfstate files (one blob per environment, e.g. prod.tfstate)."
  default     = "tfstate"
}

# ─── Terraform UMIs + GitHub OIDC federation ─────────────────────────────────
#
# One UMI per downstream stack; each UMI gets Owner on exactly one pre-created
# RG (never subscription scope). Each UMI carries one
# federated identity credential scoped to
# `repo:<github_oidc_subject_repo>:environment:<github_env>`. Adding a new env is a new
# `terraform_umis` map entry (plus the matching `github_environments` entry)
# + re-apply.

variable "github_repo" {
  type        = string
  description = "owner/repo selected by GitHub API resources managed during bootstrap."
  default     = "BritishClubChallenge/bccweb2"
}

variable "github_oidc_subject_repo" {
  type        = string
  description = "Repository segment in GitHub's OIDC subject, including immutable owner/repository IDs when enabled."
  nullable    = false

  validation {
    condition     = can(regex("^([^@/:]+/[^@/:]+|[^@/:]+@[0-9]+/[^@/:]+@[0-9]+)$", var.github_oidc_subject_repo))
    error_message = "github_oidc_subject_repo must be owner/repo or the immutable owner@id/repo@id form."
  }

  validation {
    condition     = replace(var.github_oidc_subject_repo, "/@[0-9]+/", "") == var.github_repo
    error_message = "github_oidc_subject_repo must identify the same owner/repository as github_repo."
  }
}

variable "github_environments" {
  type        = set(string)
  description = "GitHub environment names that receive the per-env Azure OIDC secrets. Every `terraform_umis` entry's `github_env` must appear in this list."
  default     = ["staging", "prod", "shared"]

  validation {
    condition     = alltrue([for e in var.github_environments : can(regex("^[a-z0-9-]+$", e))])
    error_message = "Each GitHub environment name must match ^[a-z0-9-]+$ (lowercase letters, digits, hyphens)."
  }

  validation {
    condition = alltrue([
      for e in var.github_environments : (
        length("${var.tfstate_container_prefix}-${e}") >= 3 &&
        length("${var.tfstate_container_prefix}-${e}") <= 63 &&
        can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?$", "${var.tfstate_container_prefix}-${e}")) &&
        !can(regex("--", "${var.tfstate_container_prefix}-${e}"))
      )
    ])
    error_message = "Each derived tfstate container name (<tfstate_container_prefix>-<environment>) must be 3–63 characters, start and end with a lowercase letter or digit, and contain no consecutive hyphens."
  }
}

variable "terraform_umis" {
  type = map(object({
    stamp_rg   = optional(string)
    github_env = string
  }))
  description = "Terraform UMIs keyed by stack name (staging, prod, shared). Application entries name their stamp RG; shared omits stamp_rg and owns rg-bccweb-shared. Each entry names the GitHub environment whose OIDC subject the UMI trusts. The UMI is named id-bccweb-terraform-<key>. No default — supply via terraform.tfvars (see terraform.tfvars.example)."
  nullable    = false

  validation {
    condition     = alltrue([for k, v in var.terraform_umis : can(regex("^[a-z0-9-]+$", k))])
    error_message = "Each terraform_umis key must match ^[a-z0-9-]+$ (lowercase letters, digits, hyphens)."
  }

  validation {
    condition = (
      length(var.terraform_umis) == length(var.github_environments) &&
      toset([for k, v in var.terraform_umis : v.github_env]) == var.github_environments
    )
    error_message = "github_environments and the terraform_umis github_env values must match exactly."
  }

  validation {
    condition     = alltrue([for k, v in var.terraform_umis : k == v.github_env])
    error_message = "Each terraform_umis map key must equal its github_env (the key is the identity/environment name used downstream)."
  }

  validation {
    condition = (
      contains(keys(var.terraform_umis), "shared") &&
      alltrue([
        for k, v in var.terraform_umis :
        k == "shared" ? v.stamp_rg == null : v.stamp_rg != null
      ])
    )
    error_message = "terraform_umis must include shared without stamp_rg; every application environment must set stamp_rg."
  }

  validation {
    condition = alltrue([
      for k, v in var.terraform_umis :
      k == "shared" ? true : v.stamp_rg == "stamp-${k}"
    ])
    error_message = "Each non-shared terraform_umis stamp_rg must equal stamp-<key>."
  }
}

variable "manage_github_secrets" {
  type        = bool
  description = "Set to false to provision only the UMI + fed creds and skip GitHub repo secret creation (e.g. when operating without GITHUB_TOKEN). When true (default), Terraform creates one GitHub environment per `github_environments` entry and pushes AZURE_CLIENT_ID/AZURE_TENANT_ID/AZURE_SUBSCRIPTION_ID as environment-scoped Actions secrets."
  default     = true
}
