// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * blobSeed.mjs
 *
 * Shared blob-write helpers for fixture / admin / seed scripts.
 *
 * Pure ESM, plain Node, no TypeScript. Designed to be imported by:
 *   - scripts/seed-admin.mjs
 *   - scripts/seed-fixtures.mjs
 *   - scripts/wipe-fixtures.mjs
 *   - scripts/cleanup-loadtest.mjs
 *
 * Does NOT import from apps/api/src/ — scripts are standalone.
 *
 * Public exports:
 *   getBlobServiceClient()
 *   getPublicContainer()
 *   getPrivateContainer()
 *   writeJson(container, path, obj)
 *   readJson(container, path)      → null on 404
 *   deleteBlob(container, path)    → delete-if-exists (re-run safe)
 *   listBlobs(container, prefix)   → async iterator of blob names
 *   deterministicUuid(namespace, name)  → stable UUIDv5-shape string
 *   precomputeBcryptHash(plaintext)     → bcrypt $2a/$2b$12$ hash string
 *   upsertPublicIndex(path, entry, keyField)
 *   removeFromPublicIndex(path, idValue, keyField)
 */

import bcrypt from "bcryptjs";
import { createHash } from "node:crypto";
import {
  createBlobServiceClient,
  preflightBlobReadAccess,
} from "./storageClients.mjs";

// ─── Config ───────────────────────────────────────────────────────────────────

const AZURITE_DEFAULT_CS =
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";

const BCRYPT_COST = 12;

let _blobService = null;
let _publicContainer = null;
let _privateContainer = null;
let _connectionString;

// ─── Clients ──────────────────────────────────────────────────────────────────

/**
 * Returns a memoised BlobServiceClient. Explicit configuration wins; otherwise
 * root-package fixture tooling retains its local Azurite default.
 */
export function getBlobServiceClient() {
  if (_blobService) return _blobService;
  _connectionString = process.env.BLOB_CONNECTION_STRING ??
    (process.env.BLOB_STORAGE_ACCOUNT_NAME ? undefined : AZURITE_DEFAULT_CS);
  _blobService = createBlobServiceClient({ connectionString: _connectionString });
  return _blobService;
}

export function getPublicContainer() {
  if (_publicContainer) return _publicContainer;
  const name = process.env.BLOB_CONTAINER_NAME ?? "data";
  _publicContainer = getBlobServiceClient().getContainerClient(name);
  return _publicContainer;
}

export function getPrivateContainer() {
  if (_privateContainer) return _privateContainer;
  const name = process.env.BLOB_PRIVATE_CONTAINER_NAME ?? "data-private";
  _privateContainer = getBlobServiceClient().getContainerClient(name);
  return _privateContainer;
}

export function preflightBlobContainerRead(container) {
  getBlobServiceClient();
  return preflightBlobReadAccess({ container, connectionString: _connectionString });
}

// ─── Blob primitives ──────────────────────────────────────────────────────────

/**
 * Write `obj` as JSON to `container/path` with Content-Type: application/json.
 * Overwrites any existing blob.
 */
export async function writeJson(container, path, obj) {
  await preflightBlobContainerRead(container);
  const client = container.getBlockBlobClient(path);
  const body = JSON.stringify(obj, null, 2);
  const bytes = Buffer.from(body, "utf8");
  await client.upload(bytes, bytes.length, {
    blobHTTPHeaders: { blobContentType: "application/json" },
  });
}

/**
 * Read `container/path` as JSON. Returns `null` on 404 — never throws for
 * the "missing blob" case.
 */
export async function readJson(container, path) {
  const client = container.getBlobClient(path);
  try {
    const download = await client.download();
    const chunks = [];
    for await (const chunk of download.readableStreamBody) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    if (body.length === 0) return null;
    return JSON.parse(body);
  } catch (err) {
    if (err?.statusCode === 404 || err?.code === "BlobNotFound") return null;
    throw err;
  }
}

/**
 * Delete-if-exists — safe to call when the blob may not be present.
 * Re-run safe.
 */
export async function deleteBlob(container, path) {
  await preflightBlobContainerRead(container);
  const client = container.getBlobClient(path);
  await client.deleteIfExists();
}

/**
 * Async iterator yielding blob names under `prefix` in `container`.
 *
 * Usage:
 *   for await (const name of listBlobs(container, "pilots/")) { ... }
 */
export async function* listBlobs(container, prefix) {
  for await (const blob of container.listBlobsFlat({ prefix })) {
    yield blob.name;
  }
}

// ─── Deterministic UUID (UUIDv5-shape) ───────────────────────────────────────

/**
 * Stable UUIDv5-shape string for (namespace, name). Same input → same UUID
 * across runs. Useful for fixture IDs that need to be reproducible.
 *
 * Output format: xxxxxxxx-xxxx-5xxx-yxxx-xxxxxxxxxxxx
 *   - version nibble forced to `5`
 *   - variant nibble `y` forced into {8, 9, a, b} (RFC 4122 variant)
 */
export function deterministicUuid(namespace, name) {
  const hex = createHash("sha256")
    .update(`${namespace}:${name}`)
    .digest("hex"); // 64 hex chars

  // First 32 hex chars → 8-4-4-4-12 layout
  const a = hex.slice(0, 8);
  const b = hex.slice(8, 12);
  const cRaw = hex.slice(12, 16);
  const dRaw = hex.slice(16, 20);
  const e = hex.slice(20, 32);

  // Force version nibble to 5 (UUIDv5 shape)
  const c = `5${cRaw.slice(1)}`;

  // Force variant nibble to {8, 9, a, b}
  // Map top two bits → 10xx by ORing 0x8 then masking off 0x4.
  const variantByte = parseInt(dRaw.slice(0, 1), 16);
  const variantNibble = ((variantByte & 0x3) | 0x8).toString(16);
  const d = `${variantNibble}${dRaw.slice(1)}`;

  return `${a}-${b}-${c}-${d}-${e}`;
}

// ─── Bcrypt ───────────────────────────────────────────────────────────────────

/**
 * Compute a bcrypt hash of `plaintext` at cost 12.
 *
 * Cost 12 is intentionally slow (~250-400ms per call). Callers seeding many
 * users should call this ONCE for a shared fixture password and reuse the
 * returned hash string — bcrypt comparison still works because the salt is
 * embedded in the hash.
 */
export async function precomputeBcryptHash(plaintext) {
  return bcrypt.hash(plaintext, BCRYPT_COST);
}

export function compareBcryptPassword(plaintext, passwordHash) {
  return bcrypt.compare(plaintext, passwordHash);
}

// ─── Public index upsert / remove ────────────────────────────────────────────

function sortIndex(arr, keyField) {
  arr.sort((a, b) => {
    const av = a?.name ?? a?.[keyField] ?? "";
    const bv = b?.name ?? b?.[keyField] ?? "";
    return String(av).localeCompare(String(bv));
  });
}

/**
 * Read the JSON array at `path` in the PUBLIC container, replace any entry
 * matching `entry[keyField]`, push the new entry, sort by `name` (else
 * `[keyField]`), and write back with Content-Type: application/json.
 *
 * If the blob is missing or empty, treats the existing array as `[]`.
 *
 * Used to maintain `pilots.json`, `clubs.json`, `club-teams.json`, etc.
 */
export async function upsertPublicIndex(path, entry, keyField) {
  const container = getPublicContainer();
  const existing = await readJson(container, path);
  const arr = Array.isArray(existing) ? existing : [];

  const key = entry[keyField];
  const next = arr.filter((item) => item?.[keyField] !== key);
  next.push(entry);

  sortIndex(next, keyField);

  await writeJson(container, path, next);
}

/**
 * Symmetric counterpart to upsertPublicIndex — read the array at `path`,
 * remove any entry whose `[keyField]` equals `idValue`, write back.
 *
 * If the blob is missing, this is a no-op (we still write `[]` to keep the
 * shape consistent for downstream readers).
 */
export async function removeFromPublicIndex(path, idValue, keyField) {
  const container = getPublicContainer();
  const existing = await readJson(container, path);
  const arr = Array.isArray(existing) ? existing : [];

  const next = arr.filter((item) => item?.[keyField] !== idValue);

  sortIndex(next, keyField);

  await writeJson(container, path, next);
}
