// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { RestError } from "@azure/storage-blob";
import { getBlobServiceClient } from "../storageClients.js";

export type AuditCategory = "sign-override";

export async function appendAuditLine(
  category: AuditCategory,
  payload: object,
): Promise<void> {
  const path = auditPath(category, new Date());
  const client = getPrivateContainer().getAppendBlobClient(path);
  const line = `${JSON.stringify(payload)}\n`;

  try {
    await client.create({
      blobHTTPHeaders: { blobContentType: "application/x-ndjson" },
      conditions: { ifNoneMatch: "*" },
    });
  } catch (err: unknown) {
    if (!isAlreadyExists(err)) throw err;
  }

  await client.appendBlock(line, Buffer.byteLength(line));
}

function auditPath(category: AuditCategory, date: Date): string {
  return `audit/${category}-${date.toISOString().slice(0, 10)}.jsonl`;
}

function getPrivateContainer() {
  return getBlobServiceClient().getContainerClient(
    process.env["BLOB_PRIVATE_CONTAINER_NAME"] ?? "data-private",
  );
}

function isAlreadyExists(err: unknown): boolean {
  return err instanceof RestError
    ? err.statusCode === 409
    : (err as { statusCode?: number; code?: string }).statusCode === 409 ||
        (err as { code?: string }).code === "BlobAlreadyExists";
}
