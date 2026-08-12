// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { createHash } from "node:crypto";
import type { SignToFlyWording } from "@bccweb/types";
import { ActiveWordingPointerSchema, SignToFlyWordingSchema } from "@bccweb/schemas";
import {
  getPrivateBlobClient,
  getPrivateBlockBlobClient,
  withPrivateLease,
} from "../blob.js";
import { readJson } from "../blobJson.js";
import { HttpError } from "../http.js";
import { getBlobServiceClient } from "../storageClients.js";

export interface ActiveWording {
  activeVersion: number;
}

const ACTIVE_WORDING_PATH = "sign-to-fly/wording/active.json";
const WORDING_PREFIX = "sign-to-fly/wording/";

export interface WordingVersionSummary {
  version: number;
  blobPath: string;
  lastModified: Date | undefined;
}

export async function getActiveWording(): Promise<SignToFlyWording> {
  const active = await readActiveWordingPointer();
  return getWording(active.activeVersion);
}

export async function getWording(version: number): Promise<SignToFlyWording> {
  const path = wordingVersionPath(version);
  try {
    return await readJson(
      getPrivateBlobClient(path),
      SignToFlyWordingSchema,
      path,
    );
  } catch (err: unknown) {
    if (isMissingBlob(err)) {
      throw new HttpError(404, "WORDING_VERSION_NOT_FOUND");
    }
    throw err;
  }
}

export async function addWordingVersion(opts: {
  markdown: string;
  createdBy: string;
}): Promise<SignToFlyWording> {
  const active = await readActiveWordingPointerOrNull();
  if (!active) {
    const bootstrapped = await ensureBootstrapped(opts);
    if (bootstrapped) return bootstrapped;
  }

  return addWordingVersionWithLease(opts);
}

export async function listWordingVersions(): Promise<WordingVersionSummary[]> {
  const versions: WordingVersionSummary[] = [];

  for await (const item of getPrivateContainer().listBlobsFlat({ prefix: WORDING_PREFIX })) {
    if (item.name === ACTIVE_WORDING_PATH) continue;

    const version = versionFromWordingPath(item.name);
    if (version === null) continue;

    versions.push({
      version,
      blobPath: item.name,
      lastModified: item.properties.lastModified,
    });
  }

  return versions.sort((a, b) => b.version - a.version);
}

async function addWordingVersionWithLease(opts: {
  markdown: string;
  createdBy: string;
}): Promise<SignToFlyWording> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return await addWordingVersionWithLeaseOnce(opts);
    } catch (err: unknown) {
      if (!isLeaseAlreadyPresent(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  return addWordingVersionWithLeaseOnce(opts);
}

async function addWordingVersionWithLeaseOnce(opts: {
  markdown: string;
  createdBy: string;
}): Promise<SignToFlyWording> {
  return withPrivateLease(ACTIVE_WORDING_PATH, async (leaseId) => {
    const active = await readActiveWordingPointer();
    const current = await getWording(active.activeVersion);
    const now = new Date().toISOString();
    const newVersion = current.version + 1;
    const next: SignToFlyWording = {
      version: newVersion,
      hash: hashMarkdown(opts.markdown),
      markdown: opts.markdown,
      createdAt: now,
      createdBy: opts.createdBy,
    };

    await uploadNewJson(wordingVersionPath(newVersion), next);
    await uploadJsonIfMatch(
      wordingVersionPath(current.version),
      {
        ...current,
        supersededAt: now,
        supersededBy: newVersion,
      },
      await getEtag(wordingVersionPath(current.version)),
    );
    await uploadJsonIfMatch(
      ACTIVE_WORDING_PATH,
      { activeVersion: newVersion } satisfies ActiveWording,
      await getEtag(ACTIVE_WORDING_PATH),
      leaseId,
    );

    return next;
  });
}

async function ensureBootstrapped(opts: {
  markdown: string;
  createdBy: string;
}): Promise<SignToFlyWording | null> {
  const now = new Date().toISOString();
  const first: SignToFlyWording = {
    version: 1,
    hash: hashMarkdown(opts.markdown),
    markdown: opts.markdown,
    createdAt: now,
    createdBy: opts.createdBy,
  };

  const createdFirst = await uploadNewJsonIfAbsent(wordingVersionPath(1), first);
  await uploadNewJsonIfAbsent(ACTIVE_WORDING_PATH, { activeVersion: 1 } satisfies ActiveWording);
  return createdFirst ? first : null;
}

function hashMarkdown(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("hex");
}

async function readActiveWordingPointer(): Promise<ActiveWording> {
  const active = await readActiveWordingPointerOrNull();
  if (!active) {
    throw new HttpError(503, "WORDING_NOT_SEEDED");
  }
  return active;
}

async function readActiveWordingPointerOrNull(): Promise<ActiveWording | null> {
  try {
    return await readJson(
      getPrivateBlobClient(ACTIVE_WORDING_PATH),
      ActiveWordingPointerSchema,
      ACTIVE_WORDING_PATH,
    );
  } catch (err: unknown) {
    if (isMissingBlob(err)) {
      return null;
    }
    throw err;
  }
}

async function getEtag(path: string): Promise<string> {
  const props = await getPrivateBlobClient(path).getProperties();
  if (!props.etag) {
    throw new Error(`Missing ETag for ${path}`);
  }
  return props.etag;
}

async function uploadNewJson(path: string, data: unknown): Promise<void> {
  const content = JSON.stringify(data, null, 2);
  await getPrivateBlockBlobClient(path).upload(content, Buffer.byteLength(content), {
    blobHTTPHeaders: { blobContentType: "application/json" },
    conditions: { ifNoneMatch: "*" },
  });
}

async function uploadNewJsonIfAbsent(path: string, data: unknown): Promise<boolean> {
  try {
    await uploadNewJson(path, data);
    return true;
  } catch (err: unknown) {
    if (isPreconditionFailed(err)) return false;
    throw err;
  }
}

async function uploadJsonIfMatch(
  path: string,
  data: unknown,
  ifMatch: string,
  leaseId?: string,
): Promise<void> {
  const content = JSON.stringify(data, null, 2);
  await getPrivateBlockBlobClient(path).upload(content, Buffer.byteLength(content), {
    blobHTTPHeaders: { blobContentType: "application/json" },
    conditions: { ifMatch, ...(leaseId ? { leaseId } : {}) },
  });
}

function wordingVersionPath(version: number): string {
  return `sign-to-fly/wording/${version}.json`;
}

function versionFromWordingPath(path: string): number | null {
  const name = path.slice(WORDING_PREFIX.length);
  const match = /^(\d+)\.json$/.exec(name);
  if (!match) return null;
  return Number(match[1]);
}

function isMissingBlob(err: unknown): boolean {
  return (err as { statusCode?: number }).statusCode === 404;
}

function isPreconditionFailed(err: unknown): boolean {
  const storageErr = err as { statusCode?: number; code?: string };
  return storageErr.statusCode === 412 || storageErr.code === "BlobAlreadyExists";
}

function isLeaseAlreadyPresent(err: unknown): boolean {
  const storageErr = err as { statusCode?: number; code?: string };
  return storageErr.statusCode === 409;
}

function getPrivateContainer() {
  return getBlobServiceClient().getContainerClient(
    process.env["BLOB_PRIVATE_CONTAINER_NAME"] ?? "data-private",
  );
}
