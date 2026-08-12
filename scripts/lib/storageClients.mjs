// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";
import { QueueClient, QueueServiceClient } from "@azure/storage-queue";

const ACCOUNT_NAME_PATTERN = /^[a-z0-9]{3,24}$/;
const DEVELOPMENT_STORAGE_ACCOUNT = "devstoreaccount1";

let defaultCredential;
const blobReadPreflights = new WeakSet();
const queueReadPreflights = new WeakSet();

export class StorageConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "StorageConfigurationError";
  }
}

export class StorageRbacError extends Error {
  constructor(service, roles) {
    super(
      `${service} read preflight failed in account-name mode. ` +
        `Grant the invoking identity ${roles.join(" or ")} at the required storage scope.`,
    );
    this.name = "StorageRbacError";
  }
}

function credentialFor(injectedCredential) {
  if (injectedCredential) return injectedCredential;
  defaultCredential ??= new DefaultAzureCredential();
  return defaultCredential;
}

function configuredValue(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireAccountName(environment, variableName, alternativeName) {
  const accountName = configuredValue(environment[variableName]);
  if (!accountName) {
    throw new StorageConfigurationError(
      `${alternativeName} or ${variableName} is required`,
    );
  }
  if (!ACCOUNT_NAME_PATTERN.test(accountName)) {
    throw new StorageConfigurationError(`${variableName} is not a valid Azure Storage account name`);
  }
  return accountName;
}

function connectionValues(connectionString) {
  const values = new Map();
  for (const part of connectionString.split(";")) {
    if (!part) continue;
    const separator = part.indexOf("=");
    if (separator <= 0) {
      throw new StorageConfigurationError("Storage connection string is malformed");
    }
    values.set(part.slice(0, separator).toLowerCase(), part.slice(separator + 1));
  }
  return values;
}

function canonicalEndpoint(values, service) {
  if (values.get("usedevelopmentstorage")?.toLowerCase() === "true") {
    const port = service === "blob" ? 10000 : 10001;
    return `http://127.0.0.1:${port}/${DEVELOPMENT_STORAGE_ACCOUNT}`;
  }
  const explicitEndpoint = values.get(`${service}endpoint`);
  if (explicitEndpoint) {
    const endpoint = new URL(explicitEndpoint);
    endpoint.username = "";
    endpoint.password = "";
    endpoint.search = "";
    endpoint.hash = "";
    return endpoint.toString().replace(/\/$/, "");
  }
  const accountName = values.get("accountname");
  if (!accountName) {
    throw new StorageConfigurationError("Storage connection string is missing AccountName");
  }
  const protocol = values.get("defaultendpointsprotocol") ?? "https";
  const suffix = values.get("endpointsuffix") ?? "core.windows.net";
  return `${protocol.toLowerCase()}://${accountName.toLowerCase()}.${service}.${suffix.toLowerCase()}`;
}

function isAuthorizationFailure(error) {
  return error instanceof Error &&
    (error.statusCode === 401 || error.statusCode === 403 ||
      error.code === "AuthorizationFailure" ||
      error.code === "AuthorizationPermissionMismatch");
}

export function blobStorageIdentity({ environment = process.env, connectionString } = {}) {
  const selectedConnection = configuredValue(connectionString) ??
    configuredValue(environment.BLOB_CONNECTION_STRING);
  if (selectedConnection) {
    const values = connectionValues(selectedConnection);
    return {
      accountName: values.get("usedevelopmentstorage")?.toLowerCase() === "true"
        ? DEVELOPMENT_STORAGE_ACCOUNT
        : values.get("accountname")?.toLowerCase() ?? null,
      endpoint: canonicalEndpoint(values, "blob"),
    };
  }
  const accountName = requireAccountName(
    environment,
    "BLOB_STORAGE_ACCOUNT_NAME",
    "BLOB_CONNECTION_STRING",
  );
  return {
    accountName,
    endpoint: `https://${accountName}.blob.core.windows.net`,
  };
}

export function queueStorageIdentity({ environment = process.env, connectionString } = {}) {
  const selectedConnection = configuredValue(connectionString) ??
    configuredValue(environment.AzureWebJobsStorage);
  if (selectedConnection) {
    const values = connectionValues(selectedConnection);
    return {
      accountName: values.get("usedevelopmentstorage")?.toLowerCase() === "true"
        ? DEVELOPMENT_STORAGE_ACCOUNT
        : values.get("accountname")?.toLowerCase() ?? null,
      endpoint: canonicalEndpoint(values, "queue"),
    };
  }
  const accountName = requireAccountName(
    environment,
    "RUNTIME_STORAGE_ACCOUNT_NAME",
    "AzureWebJobsStorage",
  );
  return {
    accountName,
    endpoint: `https://${accountName}.queue.core.windows.net`,
  };
}

export function createBlobServiceClient({
  environment = process.env,
  connectionString,
  credential,
} = {}) {
  const selectedConnection = configuredValue(connectionString) ??
    configuredValue(environment.BLOB_CONNECTION_STRING);
  if (selectedConnection) return BlobServiceClient.fromConnectionString(selectedConnection);
  const identity = blobStorageIdentity({ environment });
  return new BlobServiceClient(identity.endpoint, credentialFor(credential));
}

export function createQueueClient(queueName, {
  environment = process.env,
  connectionString,
  credential,
} = {}) {
  const selectedConnection = configuredValue(connectionString) ??
    configuredValue(environment.AzureWebJobsStorage);
  if (selectedConnection) return new QueueClient(selectedConnection, queueName);
  const identity = queueStorageIdentity({ environment });
  return new QueueClient(`${identity.endpoint}/${queueName}`, credentialFor(credential));
}

export function createQueueServiceClient({
  environment = process.env,
  connectionString,
  credential,
} = {}) {
  const selectedConnection = configuredValue(connectionString) ??
    configuredValue(environment.AzureWebJobsStorage);
  if (selectedConnection) return QueueServiceClient.fromConnectionString(selectedConnection);
  const identity = queueStorageIdentity({ environment });
  return new QueueServiceClient(identity.endpoint, credentialFor(credential));
}

export async function preflightBlobReadAccess({
  container,
  environment = process.env,
  connectionString,
}) {
  if (configuredValue(connectionString) ?? configuredValue(environment.BLOB_CONNECTION_STRING)) return;
  if (blobReadPreflights.has(container)) return;
  try {
    const iterator = container.listBlobsFlat()[Symbol.asyncIterator]();
    await iterator.next();
    blobReadPreflights.add(container);
  } catch (error) {
    if (!isAuthorizationFailure(error)) throw error;
    throw new StorageRbacError("Blob Storage", [
      "Storage Blob Data Reader",
      "Storage Blob Data Contributor",
    ]);
  }
}

export async function preflightQueueReadAccess({
  queue,
  environment = process.env,
  connectionString,
}) {
  if (configuredValue(connectionString) ?? configuredValue(environment.AzureWebJobsStorage)) return;
  if (queueReadPreflights.has(queue)) return;
  try {
    await queue.getProperties();
    queueReadPreflights.add(queue);
  } catch (error) {
    if (!isAuthorizationFailure(error)) throw error;
    throw new StorageRbacError("Queue Storage", [
      "Storage Queue Data Reader",
      "Storage Queue Data Contributor",
    ]);
  }
}
