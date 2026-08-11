// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0

import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";

const STORAGE_ACCOUNT_NAME_PATTERN = /^[a-z0-9]{3,24}$/;

export class BlobClientConfigurationError extends Error {
  name = "BlobClientConfigurationError";
}

export function blobServiceUrl(accountName) {
  if (!STORAGE_ACCOUNT_NAME_PATTERN.test(accountName)) {
    throw new BlobClientConfigurationError(
      "BLOB_STORAGE_ACCOUNT_NAME must be 3-24 lowercase letters or numbers",
    );
  }
  return `https://${accountName}.blob.core.windows.net`;
}

export function createBlobServiceClient() {
  const connectionString = process.env.BLOB_CONNECTION_STRING;
  if (connectionString) {
    return BlobServiceClient.fromConnectionString(connectionString);
  }

  const accountName = process.env.BLOB_STORAGE_ACCOUNT_NAME;
  if (!accountName) {
    throw new BlobClientConfigurationError(
      "Blob storage requires BLOB_CONNECTION_STRING or BLOB_STORAGE_ACCOUNT_NAME",
    );
  }

  return new BlobServiceClient(
    blobServiceUrl(accountName),
    new DefaultAzureCredential(),
  );
}
