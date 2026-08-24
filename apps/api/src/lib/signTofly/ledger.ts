// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import type { HttpRequest } from "@azure/functions";
import type { RoundBrief, Signature, SignToFlyWording } from "@bccweb/types";
import { SignatureLedgerSchema } from "@bccweb/schemas";
import {
  getPrivateBlobClient,
  getPrivateBlockBlobClient,
} from "../blob.js";
import { readJson } from "../blobJson.js";
import { trustedClientIp } from "../clientIp.js";
import { computeBriefHash } from "./briefVersion.js";
import { getBlobServiceClient } from "../storageClients.js";

export function signaturePath(
  roundId: string,
  teamId: string,
  place: number,
  pilotId: string,
  briefVersion: number,
): string {
  return `${latestSignaturePathPattern(roundId, teamId, place)}${pilotId}-v${briefVersion}.json`;
}

export function overrideSignaturePath(
  roundId: string,
  teamId: string,
  place: number,
  pilotId: string,
  briefVersion: number,
  randomShort: string,
): string {
  return `${latestSignaturePathPattern(roundId, teamId, place)}${pilotId}-v${briefVersion}-override-${randomShort}.json`;
}

export function legacySignaturePath(
  roundId: string,
  teamId: string,
  place: number,
  pilotId: string,
): string {
  return `${latestSignaturePathPattern(roundId, teamId, place)}${pilotId}-vlegacy.json`;
}

export function latestSignaturePathPattern(
  roundId: string,
  teamId: string,
  place: number,
): string {
  return `signatures/${roundId}/${teamId}-${place}-`;
}

export async function readSignature(
  roundId: string,
  teamId: string,
  place: number,
  pilotId: string,
  briefVersion: number,
): Promise<Signature | null> {
  const path = signaturePath(roundId, teamId, place, pilotId, briefVersion);
  try {
    return await readJson(
      getPrivateBlobClient(path),
      SignatureLedgerSchema,
      path,
    );
  } catch (err: unknown) {
    if (isMissingBlob(err)) return null;
    throw err;
  }
}

export async function listSignaturesForRound(roundId: string): Promise<Signature[]> {
  const prefix = `signatures/${roundId}/`;
  const signatures: Signature[] = [];

  for await (const item of getPrivateContainer().listBlobsFlat({ prefix })) {
    signatures.push(
      await readJson(
        getPrivateBlobClient(item.name),
        SignatureLedgerSchema,
        item.name,
      ),
    );
  }

  return signatures;
}

// Returns the newest signature made by THIS pilot for this team+place, or
// null. The lookup is scoped by pilotId (#263): after a roster swap, a
// former occupant's leftover signature blob must never block a different
// occupant of the same slot, so blobs belonging to other pilots are never
// considered. Legacy `-vlegacy.json` blobs carry no brief version and stay
// ignored; a record whose payload pilotId does not match the filename is
// skipped as defense-in-depth against foreign/manual writes. The remaining
// tie — same pilot, same briefVersion override blobs differing only by
// random suffix — picks arbitrarily, which is harmless because the sole
// production caller (roundUnregistration.ts) only checks truthiness.
export async function getLatestSignature(
  roundId: string,
  teamId: string,
  place: number,
  pilotId: string,
): Promise<Signature | null> {
  const prefix = `${latestSignaturePathPattern(roundId, teamId, place)}${pilotId}-`;
  let latest: Signature | null = null;

  for await (const item of getPrivateContainer().listBlobsFlat({ prefix })) {
    const version = briefVersionFromPath(item.name);
    if (version === null) continue;
    const sig = await readJson(
      getPrivateBlobClient(item.name),
      SignatureLedgerSchema,
      item.name,
    );
    if (sig.pilotId !== pilotId) continue;
    if (latest?.briefVersion !== null && latest?.briefVersion !== undefined && latest.briefVersion >= version) {
      continue;
    }
    latest = sig;
  }

  return latest;
}

export async function writeSignature(sig: Signature): Promise<void> {
  const path = signatureWritePath(sig);
  await writeSignatureToPath(sig, path);
}

export async function writeSignatureToPath(sig: Signature, path: string): Promise<void> {
  const content = JSON.stringify(sig, null, 2);

  try {
    await getPrivateBlockBlobClient(path).uploadData(Buffer.from(content), {
      blobHTTPHeaders: { blobContentType: "application/json" },
      conditions: { ifNoneMatch: "*" },
    });
  } catch (err: unknown) {
    if (isPreconditionFailed(err)) return;
    throw err;
  }
}

export function buildSignaturePayload(opts: {
  id: string;
  roundId: string;
  teamId: string;
  place: number;
  pilotId: string;
  userId: string;
  signedAt: string;
  brief: RoundBrief & { version?: number };
  wording: SignToFlyWording;
  req: HttpRequest;
  source: Signature["source"];
  overrideBy?: string;
  overrideReason?: string;
}): Signature {
  return {
    id: opts.id,
    roundId: opts.roundId,
    teamId: opts.teamId,
    place: opts.place,
    pilotId: opts.pilotId,
    userId: opts.userId,
    signedAt: opts.signedAt,
    briefVersion: opts.brief.version ?? 1,
    briefHash: computeBriefHash(opts.brief),
    wordingVersion: opts.wording.version,
    wordingHash: opts.wording.hash,
    ip: extractIp(opts.req),
    userAgent: opts.req.headers.get("user-agent") ?? null,
    source: opts.source,
    ...(opts.overrideBy ? { overrideBy: opts.overrideBy } : {}),
    ...(opts.overrideReason ? { overrideReason: opts.overrideReason } : {}),
  };
}

export function extractIp(req: HttpRequest): string | null {
  return trustedClientIp(req);
}

function signatureWritePath(sig: Signature): string {
  return sig.briefVersion === null
    ? legacySignaturePath(sig.roundId, sig.teamId, sig.place, sig.pilotId)
    : signaturePath(sig.roundId, sig.teamId, sig.place, sig.pilotId, sig.briefVersion);
}

function briefVersionFromPath(path: string): number | null {
  const match = /-v(\d+)(?:-override-[^.]+)?\.json$/.exec(path);
  if (!match) return null;
  return Number(match[1]);
}

function isMissingBlob(err: unknown): boolean {
  return (err as { statusCode?: number }).statusCode === 404;
}

function isPreconditionFailed(err: unknown): boolean {
  const storageErr = err as { statusCode?: number; code?: string };
  return storageErr.statusCode === 412 || storageErr.statusCode === 409 || storageErr.code === "BlobAlreadyExists";
}

function getPrivateContainer() {
  return getBlobServiceClient().getContainerClient(
    process.env["BLOB_PRIVATE_CONTAINER_NAME"] ?? "data-private",
  );
}
