// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BlockBlobClient } from "@azure/storage-blob";
import type { Signature } from "@bccweb/types";
import { HttpError } from "../../http.js";
import {
  assertSafeBlobPath,
  getPrivateBlobClient,
  getPrivateBlockBlobClient,
} from "../../blob.js";
import {
  getLatestSignature,
  legacySignaturePath,
  listSignaturesForRound,
  overrideSignaturePath,
  readSignature,
  signaturePath,
  writeSignature,
  writeSignatureToPath,
} from "../ledger.js";

describe("signature ledger", () => {
  it("writeSignature creates blob; readSignature retrieves it", async () => {
    const sig = makeSignature({ briefVersion: 1 });

    await writeSignature(sig);

    expect(await readSignature(sig.roundId, sig.teamId, sig.place, sig.pilotId, 1)).toEqual(sig);
    expect(
      await getPrivateBlockBlobClient(
        signaturePath(sig.roundId, sig.teamId, sig.place, sig.pilotId, 1),
      ).exists(),
    ).toBe(true);
  });

  it("writeSignature with existing path -> idempotent no-op (no second write)", async () => {
    const sig = makeSignature({ briefVersion: 1 });
    await writeSignature(sig);
    const uploadSpy = vi.spyOn(BlockBlobClient.prototype, "uploadData");

    await writeSignature({ ...sig, id: randomUUID() });

    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(await readSignature(sig.roundId, sig.teamId, sig.place, sig.pilotId, 1)).toEqual(sig);
    uploadSpy.mockRestore();
  });

  it("getLatestSignature picks highest briefVersion", async () => {
    const roundId = randomUUID();
    const teamId = randomUUID();
    const place = 3;
    const pilotId = randomUUID();
    await writeSignature(makeSignature({ roundId, teamId, place, pilotId, briefVersion: 1 }));
    const v3 = makeSignature({ roundId, teamId, place, pilotId, briefVersion: 3 });
    await writeSignature(v3);
    await writeSignature(makeSignature({ roundId, teamId, place, pilotId, briefVersion: 2 }));

    expect(await getLatestSignature(roundId, teamId, place, pilotId)).toEqual(v3);
  });

  it("getLatestSignature ignores another pilot's signatures under the same team+place", async () => {
    const roundId = randomUUID();
    const teamId = randomUUID();
    const place = 2;
    const aPilotId = randomUUID();
    const bPilotId = randomUUID();
    const aV3 = makeSignature({ roundId, teamId, place, pilotId: aPilotId, briefVersion: 3 });
    await writeSignature(aV3);
    const bV1 = makeSignature({ roundId, teamId, place, pilotId: bPilotId, briefVersion: 1 });
    await writeSignature(bV1);

    expect(await getLatestSignature(roundId, teamId, place, bPilotId)).toEqual(bV1);
    expect(await getLatestSignature(roundId, teamId, place, aPilotId)).toEqual(aV3);
  });

  it("getLatestSignature ignores legacy version-less signatures", async () => {
    const roundId = randomUUID();
    const teamId = randomUUID();
    const place = 4;
    const pilotId = randomUUID();

    await writeSignatureToPath(
      makeSignature({ roundId, teamId, place, pilotId, briefVersion: null }),
      legacySignaturePath(roundId, teamId, place, pilotId),
    );

    expect(await getLatestSignature(roundId, teamId, place, pilotId)).toBeNull();
  });

  it("listSignaturesForRound returns all under prefix", async () => {
    const roundId = randomUUID();
    const sigs = [
      makeSignature({ roundId, briefVersion: 1 }),
      makeSignature({ roundId, briefVersion: 2, place: 2 }),
    ];
    await Promise.all(sigs.map((sig) => writeSignature(sig)));

    const listed = await listSignaturesForRound(roundId);

    expect(listed).toEqual(expect.arrayContaining(sigs));
    expect(listed).toHaveLength(2);
  });

  it("path builders emit guard-safe paths for legitimate inputs", () => {
    const roundId = randomUUID();
    const teamId = randomUUID();
    const place = 5;
    const pilotId = randomUUID();
    const hash = "a1b2c3d4";

    const versioned = signaturePath(roundId, teamId, place, pilotId, 3);
    const override = overrideSignaturePath(roundId, teamId, place, pilotId, 3, hash);
    const legacy = legacySignaturePath(roundId, teamId, place, pilotId);

    expect(versioned).toMatch(/-v3\.json$/);
    expect(override).toMatch(/-v3-override-a1b2c3d4\.json$/);
    expect(legacy).toMatch(/-vlegacy\.json$/);

    for (const path of [versioned, override, legacy]) {
      expect(() => assertSafeBlobPath(path)).not.toThrow();
    }
  });

  it("hostile pilotId is rejected by the guard before any blob client is returned", () => {
    const roundId = randomUUID();
    const teamId = randomUUID();
    const place = 1;

    // The builders interpolate pilotId mid-segment, so a bare "."/".." segment
    // only arises from a traversal CHAIN; backslash bites outright (#264).
    for (const hostilePilotId of ["../../escape", "a\\b"]) {
      let client: unknown;
      let caught: unknown;
      try {
        client = getPrivateBlobClient(signaturePath(roundId, teamId, place, hostilePilotId, 2));
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(HttpError);
      expect((caught as HttpError).status).toBe(400);
      expect((caught as HttpError).code).toBe("INVALID_BLOB_PATH");
      expect(client).toBeUndefined();
    }
  });

  it("slash-bearing pilotId splits into charset-safe segments and stays contained", () => {
    // "a/b" and "../x" do NOT trip the guard: splitting on "/" leaves segments
    // that all match [A-Za-z0-9._-] and none equal to "."/"..". The seam admits
    // them as nested paths confined to signatures/<roundId>/; handler-level
    // UUID validation is the layer that rejects such ids (#264 defense-in-depth).
    const roundId = randomUUID();
    const teamId = randomUUID();
    const place = 1;

    for (const slashPilotId of ["a/b", "../x"]) {
      const path = signaturePath(roundId, teamId, place, slashPilotId, 2);
      expect(() => assertSafeBlobPath(path)).not.toThrow();
      expect(path.startsWith(`signatures/${roundId}/`)).toBe(true);
    }
  });
});

function makeSignature(overrides: Partial<Signature> = {}): Signature {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    roundId: randomUUID(),
    teamId: randomUUID(),
    place: 1,
    pilotId: randomUUID(),
    userId: randomUUID(),
    signedAt: now,
    briefVersion: 1,
    briefHash: "brief-hash",
    wordingVersion: 1,
    wordingHash: "wording-hash",
    ip: "203.0.113.1",
    userAgent: "vitest",
    source: "pilot-self",
    ...overrides,
  };
}
