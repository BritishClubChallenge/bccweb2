# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0

resource "azapi_resource" "acs_email" {
  type      = "Microsoft.Communication/emailServices@2025-09-01"
  name      = "acs-email-bccweb-shared"
  parent_id = local.shared_rg_id
  location  = "global"
  tags      = local.tags

  body = {
    properties = {
      dataLocation = "Europe"
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "azapi_resource" "acs_email_domain" {
  type      = "Microsoft.Communication/emailServices/domains@2025-09-01"
  name      = var.acs_email_domain
  parent_id = azapi_resource.acs_email.id
  location  = "global"
  tags      = local.tags

  body = {
    properties = {
      domainManagement = "CustomerManaged"
    }
  }

  response_export_values = ["properties.verificationRecords"]

}

resource "azapi_resource" "acs_sender_username" {
  type      = "Microsoft.Communication/emailServices/domains/senderUsernames@2025-09-01"
  name      = split("@", var.acs_sender_address)[0]
  parent_id = azapi_resource.acs_email_domain.id

  body = {
    properties = {
      username    = split("@", var.acs_sender_address)[0]
      displayName = "British Club Challenge"
    }
  }

}

resource "azapi_resource" "acs" {
  type      = "Microsoft.Communication/communicationServices@2025-09-01"
  name      = "acs-bccweb-shared"
  parent_id = local.shared_rg_id
  location  = "global"
  tags      = local.tags

  body = {
    properties = {
      dataLocation  = "Europe"
      linkedDomains = var.link_acs_email_domain ? [azapi_resource.acs_email_domain.id] : []
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

locals {
  acs_verification_records = try(
    azapi_resource.acs_email_domain.output.properties.verificationRecords,
    {}
  )

  acs_dns_records_for_operator = {
    domain_ownership = try(local.acs_verification_records.Domain, null)
    spf              = try(local.acs_verification_records.SPF, null)
    dkim             = try(local.acs_verification_records.DKIM, null)
    dkim2            = try(local.acs_verification_records.DKIM2, null)
    dmarc            = try(local.acs_verification_records.DMARC, null)
  }
}

output "acs_id" {
  description = "Resource ID of the shared Azure Communication Service."
  value       = azapi_resource.acs.id
}

output "acs_email_domain_id" {
  description = "Resource ID of the shared ACS email domain."
  value       = azapi_resource.acs_email_domain.id
}

output "acs_sender_address" {
  description = "Sender address configured for the shared ACS email domain."
  value       = var.acs_sender_address
}

output "acs_dns_records_for_operator" {
  description = "ACS DNS verification records for the operator to publish in the delegated Azure DNS zone (or registrar, if the email domain is not DNS-delegated to Azure)."
  value       = local.acs_dns_records_for_operator
}
