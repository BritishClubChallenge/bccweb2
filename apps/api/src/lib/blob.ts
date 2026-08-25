// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import type {
  BlobServiceClient,
  ContainerClient,
  BlobClient,
  BlockBlobClient,
} from "@azure/storage-blob";
import { getTelemetryClient } from "./telemetry.js";
import { HttpError } from "./http.js";
import {
  getBlobServiceClient,
  resetStorageClientSingletons,
} from "./storageClients.js";

// ─── Client singletons ────────────────────────────────────────────────────────

let _container: ContainerClient | null = null;
let _privateContainer: ContainerClient | null = null;
let _blobService: BlobServiceClient | null = null;

// TEST-ONLY: clears module-level container/service caches so the next access re-reads BLOB_CONNECTION_STRING / BLOB_CONTAINER_NAME / BLOB_PRIVATE_CONTAINER_NAME from env. Used by helpers/azurite.ts beforeAll to make per-file test container isolation pool-config-proof.
export function resetBlobSingletons(): void {
  _container = null;
  _privateContainer = null;
  _blobService = null;
  resetStorageClientSingletons();
}

interface LeaseRenewingOptions {
  leaseDurationSec?: number;
  renewIntervalMs?: number;
}

export class LeaseRenewalFailedError extends Error {
  readonly cause: unknown;

  constructor(path: string, cause: unknown) {
    super(`Blob lease renewal failed for ${path}`);
    this.name = "LeaseRenewalFailedError";
    this.cause = cause;
  }
}

function getBlobService(): BlobServiceClient {
  if (_blobService) return _blobService;
  _blobService = getBlobServiceClient();
  return _blobService;
}

function getContainer(): ContainerClient {
  if (_container) return _container;
  const containerName = process.env["BLOB_CONTAINER_NAME"];
  if (!containerName) {
    throw new Error("BLOB_CONTAINER_NAME environment variable is not set");
  }
  _container = getBlobService().getContainerClient(containerName);
  return _container;
}

function getPrivateContainer(): ContainerClient {
  if (_privateContainer) return _privateContainer;
  const containerName = process.env["BLOB_PRIVATE_CONTAINER_NAME"];
  if (!containerName) {
    throw new Error("BLOB_PRIVATE_CONTAINER_NAME environment variable is not set");
  }
  _privateContainer = getBlobService().getContainerClient(containerName);
  return _privateContainer;
}

// ─── Path traversal guard ────────────────────────────────────────────────────

// SECURITY: the Azure SDK resolves `..` segments in blob names, so a request-derived
// path segment is a traversal sink (cross-blob read oracle + foreign-blob write), and
// any other character outside the safe set is equally unaccounted-for. Invariant: every
// USER-INPUT-DERIVED path funnels through the four client accessors below, so this one
// guard neutralises traversal and enforces the per-segment charset for all such sinks;
// handlers still validate ids too. The eight documented raw-container seams (puretrack,
// puretrackGroups, clubs, seasonClubs, signTofly/wording, signTofly/ledger prefix
// listing, auditLog, admin config) intentionally bypass these accessors because none of
// them interpolates user input into a path.
export function assertSafeBlobPath(path: string): void {
  const unsafe =
    path.length === 0 ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    path.split("/").some((seg) => seg === "" || seg === "." || seg === "..") ||
    path.split("/").some((seg) => !/^[A-Za-z0-9._-]+$/.test(seg));
  if (unsafe) {
    throw new HttpError(400, "INVALID_BLOB_PATH", "Invalid blob path");
  }
}

// ─── Public container accessors ──────────────────────────────────────────────

export function getBlobClient(path: string): BlobClient {
  assertSafeBlobPath(path);
  return getContainer().getBlobClient(path);
}

export function getBlockBlobClient(path: string): BlockBlobClient {
  assertSafeBlobPath(path);
  return getContainer().getBlockBlobClient(path);
}

// ─── Private container accessors ─────────────────────────────────────────────

export function getPrivateBlobClient(path: string): BlobClient {
  assertSafeBlobPath(path);
  return getPrivateContainer().getBlobClient(path);
}

export function getPrivateBlockBlobClient(path: string): BlockBlobClient {
  assertSafeBlobPath(path);
  return getPrivateContainer().getBlockBlobClient(path);
}

// ─── Read / Write ─────────────────────────────────────────────────────────────

/**
 * PREFER readJson() — raw read for non-JSON content only.
 *
 * Read a JSON blob. Throws a BlobStorageError with statusCode 404 if the blob
 * does not exist, which callers can use to detect a missing document.
 */
export async function readBlob(blobClient: BlobClient): Promise<unknown> {
  const response = await blobClient.download();
  const body = await streamToString(response.readableStreamBody!);
  return JSON.parse(body);
}

/**
 * PREFER readJson() — raw read for non-JSON content only.
 *
 * Write a JSON blob to the public container, overwriting any existing content.
 * Optionally pass a leaseId to write under an active blob lease.
 *
 * Pass `options.ifNoneMatch = "*"` to perform an atomic create-only write —
 * Azure returns HTTP 409 (BlobAlreadyExists) if the blob already exists, which
 * the caller can catch and treat as a no-op (don't overwrite).
 */
export async function writeBlob<T>(
  path: string,
  data: T,
  leaseId?: string,
  options?: { ifNoneMatch?: string }
): Promise<void> {
  const client = getBlockBlobClient(path);
  const content = JSON.stringify(data, null, 2);
  const conditions: { leaseId?: string; ifNoneMatch?: string } = {};
  if (leaseId) conditions.leaseId = leaseId;
  if (options?.ifNoneMatch) conditions.ifNoneMatch = options.ifNoneMatch;
  await client.upload(content, Buffer.byteLength(content), {
    blobHTTPHeaders: { blobContentType: "application/json" },
    conditions: Object.keys(conditions).length > 0 ? conditions : undefined,
  });
}

/**
 * PREFER readJson() — raw read for non-JSON content only.
 *
 * Write a JSON blob to the private container, overwriting any existing content.
 * Optionally pass a leaseId to write under an active blob lease.
 *
 * Pass `options.ifNoneMatch = "*"` to perform an atomic create-only write —
 * Azure returns HTTP 409 (BlobAlreadyExists) if the blob already exists, which
 * the caller can catch and treat as a no-op (don't overwrite).
 */
export async function writePrivateBlob<T>(
  path: string,
  data: T,
  leaseId?: string,
  options?: { ifNoneMatch?: string }
): Promise<void> {
  const client = getPrivateBlockBlobClient(path);
  const content = JSON.stringify(data, null, 2);
  const conditions: { leaseId?: string; ifNoneMatch?: string } = {};
  if (leaseId) conditions.leaseId = leaseId;
  if (options?.ifNoneMatch) conditions.ifNoneMatch = options.ifNoneMatch;
  await client.upload(content, Buffer.byteLength(content), {
    blobHTTPHeaders: { blobContentType: "application/json" },
    conditions: Object.keys(conditions).length > 0 ? conditions : undefined,
  });
}

export async function ensureJsonIndexBlob(
  path: string,
  seed: string
): Promise<void> {
  const client = getBlockBlobClient(path);
  try {
    await client.uploadData(Buffer.from(seed), {
      blobHTTPHeaders: { blobContentType: "application/json" },
      conditions: { ifNoneMatch: "*" },
    });
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    // 409/412 ⇒ blob already exists (create-only ifNoneMatch:"*" conflict);
    // real Azure returns 409 (issue #27), Azurite likewise — both are no-ops.
    // Every other error (incl. no statusCode: network/403/500) MUST propagate.
    if (statusCode === 409 || statusCode === 412) return;
    throw err;
  }
}

export async function ensurePrivateJsonIndexBlob(
  path: string,
  seed: string
): Promise<void> {
  const client = getPrivateBlockBlobClient(path);
  try {
    await client.uploadData(Buffer.from(seed), {
      blobHTTPHeaders: { blobContentType: "application/json" },
      conditions: { ifNoneMatch: "*" },
    });
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    // 409/412 ⇒ blob already exists (create-only ifNoneMatch:"*" conflict);
    // real Azure returns 409 (issue #27), Azurite likewise — both are no-ops.
    // Every other error (incl. no statusCode: network/403/500) MUST propagate.
    if (statusCode === 409 || statusCode === 412) return;
    throw err;
  }
}

// ─── withLease ────────────────────────────────────────────────────────────────

/**
 * Acquire a 30-second lease on a public blob, execute `fn` with the leaseId,
 * then release the lease. The lease is always released (best-effort) on error.
 */
export async function withLease<T>(
  path: string,
  fn: (leaseId: string) => Promise<T>
): Promise<T> {
  return withLeaseOnClient(path, getBlockBlobClient(path), fn);
}

/**
 * Acquire a 30-second lease on a private blob, execute `fn` with the leaseId,
 * then release the lease. The lease is always released (best-effort) on error.
 */
export async function withPrivateLease<T>(
  path: string,
  fn: (leaseId: string) => Promise<T>
): Promise<T> {
  return withLeaseOnClient(path, getPrivateBlockBlobClient(path), fn);
}

// Full-jitter capped exponential backoff: synchronized linear retries form a
// thundering herd (only one waiter drains per round), so a burst of concurrent
// RMW jobs on one blob (e.g. the sign-to-fly reflect queue) can exhaust attempts
// before draining. Jitter decorrelates contenders so the lease pipelines; the
// attempt budget must exceed realistic concurrency.
const LEASE_RETRY_MAX_ATTEMPTS = 40;
const LEASE_RETRY_BASE_MS = 25;
const LEASE_RETRY_CAP_MS = 250;

function leaseRetryBackoffMs(attempt: number): number {
  const exp = Math.min(
    LEASE_RETRY_CAP_MS,
    LEASE_RETRY_BASE_MS * 2 ** (attempt - 1)
  );
  return Math.random() * exp;
}

export async function withLeaseRetry(
  path: string,
  fn: (leaseId: string) => Promise<unknown>
): Promise<void> {
  for (let attempt = 1; attempt <= LEASE_RETRY_MAX_ATTEMPTS; attempt += 1) {
    try {
      await withLease(path, fn);
      return;
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode !== 409 && statusCode !== 412) throw err;
      if (attempt === LEASE_RETRY_MAX_ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, leaseRetryBackoffMs(attempt)));
    }
  }
}

export async function withPrivateLeaseRetry<T>(
  path: string,
  fn: (leaseId: string) => Promise<T>
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= LEASE_RETRY_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await withPrivateLease(path, fn);
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode !== 409 && statusCode !== 412) throw err;
      lastErr = err;
      if (attempt < LEASE_RETRY_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, leaseRetryBackoffMs(attempt)));
      }
    }
  }
  throw lastErr;
}

async function withLeaseOnClient<T>(
  path: string,
  client: BlockBlobClient,
  fn: (leaseId: string) => Promise<T>
): Promise<T> {
  const leaseClient = client.getBlobLeaseClient();
  const response = await leaseClient.acquireLease(30);
  const leaseId = response.leaseId;
  if (!leaseId)
    throw new Error(
      `Failed to acquire blob lease for "${path}": no leaseId returned`
    );

  try {
    return await fn(leaseId);
  } finally {
    // best-effort release; failures must NOT throw or discard fn's result, but
    // are surfaced via telemetry instead of being swallowed silently.
    await leaseClient.releaseLease().catch((err: unknown) => {
      trackLeaseTrace("Blob lease release failed", {
        path,
        leaseId,
        ...safeErrorProps(err),
      });
    });
  }
}

// ─── withLeaseRenewing ────────────────────────────────────────────────────────

/**
 * Acquire a renewable lease on a public blob. A background interval renews the
 * lease while `fn` runs, then the lease is released best-effort in all cases.
 */
export async function withLeaseRenewing<T>(
  path: string,
  fn: (leaseId: string) => Promise<T>,
  opts: LeaseRenewingOptions = {}
): Promise<T> {
  return withLeaseRenewingOnClient(path, getBlockBlobClient(path), fn, opts);
}

/**
 * Acquire a renewable lease on a private blob. A background interval renews the
 * lease while `fn` runs, then the lease is released best-effort in all cases.
 */
export async function withPrivateLeaseRenewing<T>(
  path: string,
  fn: (leaseId: string) => Promise<T>,
  opts: LeaseRenewingOptions = {}
): Promise<T> {
  return withLeaseRenewingOnClient(path, getPrivateBlockBlobClient(path), fn, opts);
}

async function withLeaseRenewingOnClient<T>(
  path: string,
  client: BlockBlobClient,
  fn: (leaseId: string) => Promise<T>,
  opts: LeaseRenewingOptions
): Promise<T> {
  const leaseDurationSec = opts.leaseDurationSec ?? 30;
  const renewIntervalMs = opts.renewIntervalMs ?? 15_000;

  if (renewIntervalMs > leaseDurationSec * 500) {
    throw new Error("renewal interval too long");
  }

  const leaseClient = client.getBlobLeaseClient();
  const response = await leaseClient.acquireLease(leaseDurationSec);
  const leaseId = response.leaseId;
  if (!leaseId)
    throw new Error(
      `Failed to acquire blob lease for "${path}": no leaseId returned`
    );

  trackLeaseTrace("Blob lease acquired", { path, leaseId });

  let attempt = 0;
  let totalRenewals = 0;
  let renewalError: unknown = null;
  let renewing = false;
  let stopping = false;
  // The renew body catches every error into `renewalError`, so this promise
  // never rejects; `void` marks it deliberately floating (no-misused-promises).
  const handle = setInterval(() => {
    void (async () => {
      if (renewing || stopping) return;
      renewing = true;
      attempt += 1;
      try {
        await leaseClient.renewLease();
        if (stopping) return;
        totalRenewals += 1;
        trackLeaseTrace("Blob lease renewed", {
          path,
          leaseId,
          attempt,
        });
      } catch (err) {
        if (stopping) return;
        renewalError = err;
        clearInterval(handle);
      } finally {
        renewing = false;
      }
    })();
  }, renewIntervalMs);

  let fnError: unknown = null;
  try {
    return await fn(leaseId);
  } catch (err) {
    fnError = err;
    throw err;
  } finally {
    stopping = true;
    clearInterval(handle);
    let released = true;
    await leaseClient.releaseLease().catch((err: unknown) => {
      released = false;
      trackLeaseTrace("Blob lease release failed", {
        path,
        leaseId,
        totalRenewals,
        ...safeErrorProps(err),
      });
    });
    if (released) {
      trackLeaseTrace("Blob lease released", {
        path,
        leaseId,
        totalRenewals,
      });
    }
    if (renewalError && !fnError) {
      throw new LeaseRenewalFailedError(path, renewalError);
    }
  }
}

// ─── withRoundAndBriefLease ─────────────────────────────────────────────────

/**
 * Acquire BOTH the round lease and its brief lease for an atomic cross-blob
 * read-modify-write, in a FIXED order to prevent deadlock: the ROUND lease
 * (`rounds/{id}.json`) is taken FIRST, THEN the BRIEF lease
 * (`round-briefs/{id}.json`); on completion they release in reverse order
 * (brief, then round) via the nested `finally`s. Both are private 30s leases
 * that RETRY on 409/412 contention, so two concurrent cross-blob edits serialize
 * and both succeed rather than one failing. `fn` receives
 * `(roundLeaseId, briefLeaseId)`.
 *
 * The brief blob MUST already exist — you cannot lease a missing blob, so the
 * caller create-or-skips it (`writePrivateBlob(..., { ifNoneMatch: "*" })`)
 * BEFORE calling this. This is the single cross-blob lease primitive the brief
 * edit / brief-complete / signature flows route through, so the round→brief
 * ordering is defined in exactly one place.
 */
export async function withRoundAndBriefLease<T>(
  roundId: string,
  fn: (roundLeaseId: string, briefLeaseId: string) => Promise<T>
): Promise<T> {
  return withPrivateLeaseRetry(`rounds/${roundId}.json`, (roundLeaseId) =>
    withPrivateLeaseRetry(`round-briefs/${roundId}.json`, (briefLeaseId) =>
      fn(roundLeaseId, briefLeaseId)
    )
  );
}

function trackLeaseTrace(
  message: string,
  properties: Record<string, unknown>
): void {
  const client = getTelemetryClient();
  client?.trackTrace({ message, properties });
}

function safeErrorProps(err: unknown): Record<string, unknown> {
  const props: Record<string, unknown> = {
    errorName: err instanceof Error ? err.name : "unknown",
  };
  const statusCode = (err as { statusCode?: unknown } | null)?.statusCode;
  if (typeof statusCode === "number") props.statusCode = statusCode;
  return props;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function streamToString(
  stream: NodeJS.ReadableStream
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}
