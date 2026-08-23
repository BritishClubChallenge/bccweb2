// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * T7 — brief-complete safety invariant: freeze + sign-to-fly invalidation.
 *
 * Exercises `briefCompleteRound` (Confirmed→BriefComplete) and `reopenBrief`
 * (BriefComplete→Confirmed) via registered API handlers (Vitest, NOT real HTTP).
 *
 * Round + brief + signature fixtures are seeded DIRECTLY (raw blob writes) — the
 * sign-to-fly wording/sign flow is deliberately NOT exercised here (T9 owns it),
 * so signatures are written as ledger blobs to drive invalidation keying.
 *
 * Covers the plan's T7 acceptance checklist:
 *  - first brief-complete sets brief.hash, keeps version:1, PARSES under enforce.
 *  - G2: brief-complete with NO brief blob → 409 BRIEF_REQUIRED (not lazy-created).
 *  - roster incomplete (Filled slot, no snapshot) → 409.
 *  - material change → version+1, versionHistory entry w/ createdAt+createdBy,
 *    prior signers signToFly===false, refreshed teams/date, invalidatedSignatureCount.
 *  - no-material-change re-complete → signatures retained.
 *  - reopenBrief on BriefComplete → 200/Confirmed/signatures unchanged; else 409.
 *  - R4: brief-complete + reopen responses include invalidatedSignatureCount.
 *  - R7: the material-change versionHistory entry PARSES under enforce.
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Round, RoundBrief, Season, Signature } from "@bccweb/types";
import { BriefSchema } from "@bccweb/schemas";

import { invoke, makeAuthRequest } from "../../__tests__/helpers/api.js";
import {
  makeUser,
  readPrivateJson,
  writePrivateJson,
  writePublicJson,
  privateBlobExists,
} from "../../__tests__/helpers/seed.js";
import { getPrivateBlobClient } from "../../lib/blob.js";
import { readJson } from "../../lib/blobJson.js";
import { computeBriefHash } from "../../lib/signTofly/briefVersion.js";
import { signaturePath } from "../../lib/signTofly/ledger.js";
import "../roundsMutate.js";

interface Ctx {
  roundId: string;
  teamId: string;
  pilotId: string;
  clubId: string;
  adminUserId: string;
  adminEmail: string;
  year: number;
}

function withSchemaMode<T>(mode: "enforce" | "observe", fn: () => Promise<T>): Promise<T> {
  const original = process.env["BLOB_SCHEMA_MODE"];
  process.env["BLOB_SCHEMA_MODE"] = mode;
  return fn().finally(() => {
    if (original === undefined) delete process.env["BLOB_SCHEMA_MODE"];
    else process.env["BLOB_SCHEMA_MODE"] = original;
  });
}

async function seedConfirmedRound(opts: {
  signToFly?: boolean;
  slotFilled?: boolean;
  withSnapshot?: boolean;
} = {}): Promise<Ctx> {
  const signToFly = opts.signToFly ?? false;
  const slotFilled = opts.slotFilled ?? true;
  const withSnapshot = opts.withSnapshot ?? true;

  const year = 3000 + Math.floor(Math.random() * 6_000);
  const clubId = randomUUID();
  const { user: admin } = await makeUser({ roles: ["Admin"], clubId });
  const pilotId = randomUUID();
  const teamId = randomUUID();
  const roundId = randomUUID();

  const round: Round = {
    id: roundId,
    date: `${year}-06-09`,
    status: "Confirmed",
    isLocked: false,
    maxTeams: 8,
    minimumScore: 0,
    site: {
      id: randomUUID(),
      name: "Milk Hill",
      parkingW3W: "filled.count.soap",
      briefingW3W: "brief.count.soap",
      takeOffW3W: "takeoff.count.soap",
    },
    organisingClub: { id: clubId, name: "Test Club" },
    season: { year },
    teams: [
      {
        id: teamId,
        teamName: "Alpha",
        club: { id: clubId, name: "Test Club" },
        score: 0,
        pilots: [
          {
            placeInTeam: 1,
            isScoring: true,
            status: slotFilled ? "Filled" : "Empty",
            accountedFor: false,
            signToFly,
            noScore: false,
            pilotPoints: 0,
            pilotId: slotFilled ? pilotId : null,
            snapshot: withSnapshot ? { wingClass: "EN B", pilotRating: "Pilot" } : null,
            flight: null,
          },
        ],
      },
    ],
  };
  await writePrivateJson(`rounds/${roundId}.json`, round);
  await writePublicJson(`seasons/${year}.json`, {
    id: `season-${year}`,
    year,
    active: true,
    rounds: [roundId],
    leagueTable: [],
  } satisfies Season);

  return { roundId, teamId, pilotId, clubId, adminUserId: admin.id, adminEmail: admin.email, year };
}

function makeBrief(ctx: Ctx, over: Partial<RoundBrief> = {}): RoundBrief {
  return {
    roundId: ctx.roundId,
    generatedAt: "2026-06-01T08:00:00.000Z",
    date: `${ctx.year}-06-09`,
    siteName: "Milk Hill",
    parkingW3W: "filled.count.soap",
    briefingW3W: "brief.count.soap",
    takeOffW3W: "takeoff.count.soap",
    windSpeedDirection: "NW 15kt",
    version: 1,
    teams: [],
    ...over,
  };
}

function makeSignature(ctx: Ctx, briefVersion: number): Signature {
  return {
    id: randomUUID(),
    roundId: ctx.roundId,
    teamId: ctx.teamId,
    place: 1,
    pilotId: ctx.pilotId,
    userId: ctx.adminUserId,
    signedAt: new Date().toISOString(),
    briefVersion,
    briefHash: "seed-brief-hash",
    wordingVersion: 1,
    wordingHash: "seed-wording-hash",
    ip: "203.0.113.10",
    userAgent: "vitest",
    source: "pilot-self",
  };
}

function briefComplete(ctx: Ctx) {
  return invoke(
    "briefCompleteRound",
    makeAuthRequest(ctx.adminUserId, ctx.adminEmail, {
      method: "POST",
      params: { id: ctx.roundId },
    }),
  );
}

function reopen(ctx: Ctx) {
  return invoke(
    "reopenBrief",
    makeAuthRequest(ctx.adminUserId, ctx.adminEmail, {
      method: "POST",
      params: { id: ctx.roundId },
    }),
  );
}

describe("briefCompleteRound — freeze + sign-to-fly invalidation (T7)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("first brief-complete sets brief.hash, keeps version:1, and PARSES under enforce", async () => {
    const ctx = await seedConfirmedRound();
    await writePrivateJson(`round-briefs/${ctx.roundId}.json`, makeBrief(ctx)); // no hash

    const res = await withSchemaMode("enforce", () => briefComplete(ctx));

    expect(res.status).toBe(200);
    expect((res.jsonBody as Round).status).toBe("BriefComplete");

    const after = await readJson(
      getPrivateBlobClient(`round-briefs/${ctx.roundId}.json`),
      BriefSchema,
      `round-briefs/${ctx.roundId}.json`,
    );
    expect(after.hash).toBeTruthy();
    expect(after.version).toBe(1);
    expect(after.versionHistory ?? []).toHaveLength(0);
    // Derived refresh: teams rebuilt from the live round (1 snapshot-able pilot).
    expect(after.teams).toHaveLength(1);
    expect(after.date).toBe(`${ctx.year}-06-09`);
  });

  it("G2: brief-complete with NO brief blob → 409 BRIEF_REQUIRED (not lazy-created)", async () => {
    const ctx = await seedConfirmedRound();
    // Intentionally seed NO brief blob.

    const res = await briefComplete(ctx);

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("BRIEF_REQUIRED");
    // Safety path must NOT lazy-create a brief.
    expect(await privateBlobExists(`round-briefs/${ctx.roundId}.json`)).toBe(false);
    // Round stays Confirmed (transition aborted).
    const round = await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`);
    expect(round?.status).toBe("Confirmed");
  });

  it("roster incomplete: a Filled slot with no snapshot → 409", async () => {
    const ctx = await seedConfirmedRound({ withSnapshot: false });
    await writePrivateJson(`round-briefs/${ctx.roundId}.json`, makeBrief(ctx));

    const res = await briefComplete(ctx);

    expect(res.status).toBe(409);
    const round = await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`);
    expect(round?.status).toBe("Confirmed");
  });

  it("material change → version+1, versionHistory entry, prior signer signToFly=false, refreshed derived, invalidatedSignatureCount", async () => {
    const ctx = await seedConfirmedRound({ signToFly: true });
    // Stored hash deliberately does NOT match the brief's material content → bump.
    await writePrivateJson(
      `round-briefs/${ctx.roundId}.json`,
      makeBrief(ctx, { version: 1, hash: "STALE-HASH-V1" }),
    );
    await writePrivateJson(signaturePath(ctx.roundId, ctx.teamId, 1, ctx.pilotId, 1), makeSignature(ctx, 1));

    const res = await briefComplete(ctx);

    expect(res.status).toBe(200);
    expect((res.jsonBody as { invalidatedSignatureCount: number }).invalidatedSignatureCount).toBe(1);

    const after = await readPrivateJson<RoundBrief>(`round-briefs/${ctx.roundId}.json`);
    expect(after?.version).toBe(2);
    expect(after?.versionHistory).toHaveLength(1);
    const entry = after?.versionHistory?.[0];
    expect(entry?.version).toBe(1);
    expect(entry?.hash).toBe("STALE-HASH-V1");
    expect(entry?.createdAt).toBeTruthy();
    expect(entry?.createdBy).toBe(ctx.adminUserId);
    expect(entry?.supersededAt).toBeTruthy();
    expect(after?.hash).toBe(computeBriefHash(after!));
    expect(after?.teams).toHaveLength(1); // refreshed derived

    const round = await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`);
    expect(round?.status).toBe("BriefComplete");
    expect(round?.teams[0]?.pilots[0]?.signToFly).toBe(false); // prior signer invalidated
  });

  it("no material change → re-complete retains signatures (signToFly stays true, count 0)", async () => {
    const ctx = await seedConfirmedRound({ signToFly: true });
    const brief = makeBrief(ctx, { version: 1 });
    brief.hash = computeBriefHash(brief); // hash matches material content → NO bump
    await writePrivateJson(`round-briefs/${ctx.roundId}.json`, brief);
    const sigPath = signaturePath(ctx.roundId, ctx.teamId, 1, ctx.pilotId, 1);
    await writePrivateJson(sigPath, makeSignature(ctx, 1));

    const res = await briefComplete(ctx);

    expect(res.status).toBe(200);
    expect((res.jsonBody as { invalidatedSignatureCount: number }).invalidatedSignatureCount).toBe(0);

    const after = await readPrivateJson<RoundBrief>(`round-briefs/${ctx.roundId}.json`);
    expect(after?.version).toBe(1);
    expect(after?.versionHistory ?? []).toHaveLength(0);
    const round = await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`);
    expect(round?.teams[0]?.pilots[0]?.signToFly).toBe(true); // retained
    expect(await privateBlobExists(sigPath)).toBe(true); // signature blob retained
  });

  it("reopenBrief on BriefComplete → 200/Confirmed, signatures unchanged, invalidatedSignatureCount:0 (R4)", async () => {
    const ctx = await seedConfirmedRound({ signToFly: true });
    const brief = makeBrief(ctx, { version: 1 });
    brief.hash = computeBriefHash(brief);
    await writePrivateJson(`round-briefs/${ctx.roundId}.json`, brief);
    const sigPath = signaturePath(ctx.roundId, ctx.teamId, 1, ctx.pilotId, 1);
    await writePrivateJson(sigPath, makeSignature(ctx, 1));

    // Move to BriefComplete first.
    const completeRes = await briefComplete(ctx);
    expect(completeRes.status).toBe(200);

    const res = await reopen(ctx);

    expect(res.status).toBe(200);
    expect((res.jsonBody as Round).status).toBe("Confirmed");
    expect((res.jsonBody as { invalidatedSignatureCount: number }).invalidatedSignatureCount).toBe(0);

    // Option A: signatures persist across reopen (not voided).
    expect(await privateBlobExists(sigPath)).toBe(true);
    const round = await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`);
    expect(round?.teams[0]?.pilots[0]?.signToFly).toBe(true);
  });

  it("reopenBrief on a non-BriefComplete round → 409", async () => {
    const ctx = await seedConfirmedRound(); // status Confirmed
    await writePrivateJson(`round-briefs/${ctx.roundId}.json`, makeBrief(ctx));

    const res = await reopen(ctx);

    expect(res.status).toBe(409);
  });

  it("R4: brief-complete response includes invalidatedSignatureCount", async () => {
    const ctx = await seedConfirmedRound();
    await writePrivateJson(`round-briefs/${ctx.roundId}.json`, makeBrief(ctx));

    const res = await briefComplete(ctx);

    expect(res.status).toBe(200);
    expect(res.jsonBody).toHaveProperty("invalidatedSignatureCount");
    expect((res.jsonBody as { invalidatedSignatureCount: number }).invalidatedSignatureCount).toBe(0);
  });

  it("R7: material-change versionHistory entry PARSES under enforce with createdAt + createdBy", async () => {
    const ctx = await seedConfirmedRound({ signToFly: true });
    await writePrivateJson(
      `round-briefs/${ctx.roundId}.json`,
      makeBrief(ctx, { version: 1, hash: "STALE-HASH-ENFORCE" }),
    );
    await writePrivateJson(signaturePath(ctx.roundId, ctx.teamId, 1, ctx.pilotId, 1), makeSignature(ctx, 1));

    const res = await withSchemaMode("enforce", () => briefComplete(ctx));
    expect(res.status).toBe(200);

    // Re-read under enforce: if createdAt/createdBy were missing the entry would
    // be healed away (array would be empty), so a surviving entry proves R7.
    const after = await withSchemaMode("enforce", () =>
      readJson(
        getPrivateBlobClient(`round-briefs/${ctx.roundId}.json`),
        BriefSchema,
        `round-briefs/${ctx.roundId}.json`,
      ),
    );
    expect(after.version).toBe(2);
    expect(after.versionHistory).toHaveLength(1);
    expect(after.versionHistory?.[0]?.createdAt).toBeTruthy();
    expect(after.versionHistory?.[0]?.createdBy).toBe(ctx.adminUserId);
  });
});
