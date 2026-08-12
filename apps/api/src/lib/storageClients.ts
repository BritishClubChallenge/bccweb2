// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { ManagedIdentityCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";
import { QueueClient } from "@azure/storage-queue";

type IdentityConfig = {
  readonly accountName: string;
  readonly clientId: string;
};

export class StorageConfigError extends Error {
  readonly name = "StorageConfigError";

  constructor(readonly missingVariable: string) {
    super(`${missingVariable} environment variable is not set`);
  }
}

let blobServiceClient: BlobServiceClient | null = null;
const runtimeQueueClients = new Map<string, QueueClient>();
const credentials = new Map<string, ManagedIdentityCredential>();

function getIdentityConfig(accountVariable: string): IdentityConfig {
  const accountName = process.env[accountVariable];
  const clientId = process.env["STORAGE_UMI_CLIENT_ID"];

  if (!accountName) throw new StorageConfigError(accountVariable);
  if (!clientId) throw new StorageConfigError("STORAGE_UMI_CLIENT_ID");

  return { accountName, clientId };
}

function getCredential(clientId: string): ManagedIdentityCredential {
  const cached = credentials.get(clientId);
  if (cached) return cached;

  const credential = new ManagedIdentityCredential({ clientId });
  credentials.set(clientId, credential);
  return credential;
}

export function getBlobServiceClient(): BlobServiceClient {
  if (blobServiceClient) return blobServiceClient;

  const connectionString = process.env["BLOB_CONNECTION_STRING"];
  if (connectionString) {
    blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    return blobServiceClient;
  }

  const { accountName, clientId } = getIdentityConfig(
    "BLOB_STORAGE_ACCOUNT_NAME",
  );
  blobServiceClient = new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`,
    getCredential(clientId),
  );
  return blobServiceClient;
}

export function getRuntimeQueueClient(queueName: string): QueueClient {
  const cached = runtimeQueueClients.get(queueName);
  if (cached) return cached;

  const connectionString = process.env["AzureWebJobsStorage"];
  if (connectionString) {
    const client = new QueueClient(connectionString, queueName);
    runtimeQueueClients.set(queueName, client);
    return client;
  }

  const { accountName, clientId } = getIdentityConfig(
    "RUNTIME_STORAGE_ACCOUNT_NAME",
  );
  const client = new QueueClient(
    `https://${accountName}.queue.core.windows.net/${queueName}`,
    getCredential(clientId),
  );
  runtimeQueueClients.set(queueName, client);
  return client;
}

export function resetStorageClientSingletons(): void {
  blobServiceClient = null;
  runtimeQueueClients.clear();
  credentials.clear();
}
