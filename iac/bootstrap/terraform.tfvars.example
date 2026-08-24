# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
# COMMITTED CANONICAL CONFIGURATION. terraform.tfvars is tracked; keep this example byte-identical for bootstrap recovery/reference.
#
# `tfstate_storage_account_name` must be globally unique (3–24 chars,
# lowercase letters and digits). The canonical `terraform_umis` map below is
# the staging + prod + shared model: one UMI per downstream stack, each owning
# exactly its pre-created stamp or shared RG.

tfstate_storage_account_name = "stbccweb13afe"
github_oidc_subject_repo     = "BritishClubChallenge@318211912/bccweb2@1264013182"
location                     = "swedencentral"

github_environments = ["staging", "prod", "shared"]

terraform_umis = {
  staging = {
    stamp_rg   = "stamp-staging"
    github_env = "staging"
  }
  prod = {
    stamp_rg   = "stamp-prod"
    github_env = "prod"
  }
  shared = {
    github_env = "shared"
  }
}
