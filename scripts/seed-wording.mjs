// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import {
  ACTIVE_WORDING_PATH,
  WORDING_PATH,
  activeWordingPointer,
  buildCanonicalSignToFlyWording,
} from "./lib/loadTestWording.mjs";
import {
  createBlobServiceClient,
  preflightBlobReadAccess,
} from "./lib/storageClients.mjs";

const containerName = process.env["BLOB_PRIVATE_CONTAINER_NAME"] ?? "data-private";
const container = createBlobServiceClient()
  .getContainerClient(containerName);
await preflightBlobReadAccess({ container });
await container.createIfNotExists();
const wording = buildCanonicalSignToFlyWording(new Date().toISOString());

const wordingClient = container.getBlockBlobClient(WORDING_PATH);
const existing = await readJsonIfExists(wordingClient);
if (existing && existing.hash === wording.hash) {
  console.log(`skip ${WORDING_PATH}: existing hash matches ${wording.hash}`);
} else if (existing) {
  throw new Error(`${WORDING_PATH} already exists with different hash ${existing.hash}`);
} else {
  await uploadJson(wordingClient, wording);
  console.log(`wrote ${WORDING_PATH}: ${wording.hash}`);
}

await uploadJson(container.getBlockBlobClient(ACTIVE_WORDING_PATH), activeWordingPointer());
console.log(`wrote ${ACTIVE_WORDING_PATH}: activeVersion=1`);

async function readJsonIfExists(client) {
  try {
    const response = await client.download();
    const chunks = [];
    for await (const chunk of response.readableStreamBody) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (err) {
    if (err?.statusCode === 404) return null;
    throw err;
  }
}

async function uploadJson(client, data) {
  const content = JSON.stringify(data, null, 2);
  await client.upload(content, Buffer.byteLength(content), {
    blobHTTPHeaders: { blobContentType: "application/json" },
  });
}
