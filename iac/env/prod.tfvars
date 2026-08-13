# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0

stamp_name = "prod"
location   = "swedencentral"

tfstate_resource_group_name  = "rg-bccweb-tfstate"
tfstate_storage_account_name = "stbccweb13afe"
stamp_rg_name                = "stamp-prod"

app_url         = "https://www.advance-bcc.uk"
allowed_origins = ["https://www.advance-bcc.uk"]
tags            = {}

jwt_secret_version = "1"
acs_secret_version = "1"
blob_schema_mode   = "observe"
