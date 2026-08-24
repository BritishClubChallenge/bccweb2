// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BlockBlobClient } from "@azure/storage-blob";
import type { Signature } from "@bccweb/types";
import { getPrivateBlockBlobClient } from "../../blob.js";
import {
  getLatestSignature,
  legacySignaturePath,
  listSignaturesForRound,
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
