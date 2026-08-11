// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { createHash } from "node:crypto";
import {
  LOCAL_AZURITE_QUEUE_CONNECTION,
  resolveReflectQueueConnection,
} from "./loadTestReflectQueues.mjs";
import { blobStorageIdentity, queueStorageIdentity } from "./storageClients.mjs";

const LOCAL_AZURITE_BLOB_CONNECTION =
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=local-only;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";

function isLoopback(baseUrl) {
  const host = new URL(baseUrl).hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function loadTestTargetIdentity(baseUrl, environment = process.env) {
  const local = isLoopback(baseUrl);
  const blobConnection = environment.BLOB_CONNECTION_STRING ??
    (local && !environment.BLOB_STORAGE_ACCOUNT_NAME ? LOCAL_AZURITE_BLOB_CONNECTION : undefined);
  const queueConnection = environment.AzureWebJobsStorage ??
    (environment.RUNTIME_STORAGE_ACCOUNT_NAME
      ? undefined
      : resolveReflectQueueConnection(baseUrl, environment) ??
        (local ? LOCAL_AZURITE_QUEUE_CONNECTION : undefined));
  const target = {
    apiOrigin: new URL(baseUrl).origin.toLowerCase(),
    blob: blobStorageIdentity({ environment, connectionString: blobConnection }),
    publicContainer: environment.BLOB_CONTAINER_NAME ?? "data",
    privateContainer: environment.BLOB_PRIVATE_CONTAINER_NAME ?? "data-private",
    queues: queueStorageIdentity({ environment, connectionString: queueConnection }),
  };
  return createHash("sha256").update(JSON.stringify(target)).digest("hex");
}
