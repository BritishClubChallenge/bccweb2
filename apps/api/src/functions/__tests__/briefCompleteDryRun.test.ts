// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * dryRun preview for brief-complete + reopen (blast-radius preview).
 *
 * The RoundManage confirm modal opens by POSTing `?dryRun=true` to preview how
 * many pilot signatures a transition would reset BEFORE the coordinator
 * confirms. These tests pin the invariant that `?dryRun=true` is a NON-MUTATING
 * preview: it returns `{ invalidatedSignatureCount }` and leaves the round's
 * status / brief-freeze / sign-to-fly flags exactly as they were.
 *
 * Written TDD-first: before the fix the API ignores `?dryRun` and EXECUTES the
 * transition, so the "status unchanged" assertions fail.
 *
 * Fixtures mirror briefCompleteFreeze.test.ts — round + brief + signature blobs
 * are seeded directly; the sign-to-fly sign flow is not exercised here.
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Round, RoundBrief, RoundStatus, Season, Signature } from "@bccweb/types";

import { invoke, makeAuthRequest } from "../../__tests__/helpers/api.js";
import {
  makeUser,
  readPrivateJson,
  writePrivateJson,
  writePublicJson,
  privateBlobExists,
} from "../../__tests__/helpers/seed.js";
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

async function seedRound(opts: {
  status?: RoundStatus;
  signToFly?: boolean;
  slotFilled?: boolean;
  withSnapshot?: boolean;
} = {}): Promise<Ctx> {
  const status = opts.status ?? "Confirmed";
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
    status,
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

function briefComplete(ctx: Ctx, query: Record<string, string> = {}) {
  return invoke(
    "briefCompleteRound",
    makeAuthRequest(ctx.adminUserId, ctx.adminEmail, {
      method: "POST",
      params: { id: ctx.roundId },
      query,
    }),
  );
}

function reopen(ctx: Ctx, query: Record<string, string> = {}) {
  return invoke(
    "reopenBrief",
    makeAuthRequest(ctx.adminUserId, ctx.adminEmail, {
      method: "POST",
      params: { id: ctx.roundId },
      query,
    }),
  );
}

describe("brief-complete / reopen dryRun preview (non-mutating blast-radius)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("brief-complete?dryRun=true returns invalidatedSignatureCount WITHOUT freezing or transitioning", async () => {
    const ctx = await seedRound({ signToFly: true });
    // Stored hash deliberately mismatches material content → a REAL complete
    // would bump version and invalidate the prior signer.
    const seededBrief = makeBrief(ctx, { version: 1, hash: "STALE-HASH-V1" });
    await writePrivateJson(`round-briefs/${ctx.roundId}.json`, seededBrief);
    const sigPath = signaturePath(ctx.roundId, ctx.teamId, 1, ctx.pilotId, 1);
    await writePrivateJson(sigPath, makeSignature(ctx, 1));

    const res = await briefComplete(ctx, { dryRun: "true" });

    expect(res.status).toBe(200);
    expect(res.jsonBody).toHaveProperty("invalidatedSignatureCount");
    expect((res.jsonBody as { invalidatedSignatureCount: number }).invalidatedSignatureCount).toBe(1);
    // Preview must NOT leak the mutated round back to the client.
    expect((res.jsonBody as { status?: string }).status).toBeUndefined();

    // Round unchanged: still Confirmed, slot still signed.
    const round = await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`);
    expect(round?.status).toBe("Confirmed");
    expect(round?.teams[0]?.pilots[0]?.signToFly).toBe(true);

    // Brief unchanged: NOT frozen (version/hash/history untouched).
    const brief = await readPrivateJson<RoundBrief>(`round-briefs/${ctx.roundId}.json`);
    expect(brief?.version).toBe(1);
    expect(brief?.hash).toBe("STALE-HASH-V1");
    expect(brief?.versionHistory ?? []).toHaveLength(0);

    // Signature retained.
    expect(await privateBlobExists(sigPath)).toBe(true);
  });

  it("after a dryRun preview, the REAL brief-complete still transitions + freezes", async () => {
    const ctx = await seedRound({ signToFly: true });
    await writePrivateJson(
      `round-briefs/${ctx.roundId}.json`,
      makeBrief(ctx, { version: 1, hash: "STALE-HASH-V1" }),
    );
    await writePrivateJson(signaturePath(ctx.roundId, ctx.teamId, 1, ctx.pilotId, 1), makeSignature(ctx, 1));

    const preview = await briefComplete(ctx, { dryRun: "true" });
    expect(preview.status).toBe(200);
    expect((preview.jsonBody as { invalidatedSignatureCount: number }).invalidatedSignatureCount).toBe(1);
    // Preview left it Confirmed…
    expect((await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`))?.status).toBe("Confirmed");

    // …now the real (no dryRun) call commits the transition.
    const real = await briefComplete(ctx);
    expect(real.status).toBe(200);
    expect((real.jsonBody as Round).status).toBe("BriefComplete");
    expect((real.jsonBody as { invalidatedSignatureCount: number }).invalidatedSignatureCount).toBe(1);

    const round = await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`);
    expect(round?.status).toBe("BriefComplete");
    expect(round?.teams[0]?.pilots[0]?.signToFly).toBe(false);
    const brief = await readPrivateJson<RoundBrief>(`round-briefs/${ctx.roundId}.json`);
    expect(brief?.version).toBe(2);
  });

  it("brief-complete?dryRun=true with no material change previews count 0 and stays Confirmed", async () => {
    const ctx = await seedRound({ signToFly: true });
    const brief = makeBrief(ctx, { version: 1 });
    brief.hash = computeBriefHash(brief); // hash matches → no bump → nothing invalidated
    await writePrivateJson(`round-briefs/${ctx.roundId}.json`, brief);
    await writePrivateJson(signaturePath(ctx.roundId, ctx.teamId, 1, ctx.pilotId, 1), makeSignature(ctx, 1));

    const res = await briefComplete(ctx, { dryRun: "true" });

    expect(res.status).toBe(200);
    expect((res.jsonBody as { invalidatedSignatureCount: number }).invalidatedSignatureCount).toBe(0);
    const round = await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`);
    expect(round?.status).toBe("Confirmed");
    expect(round?.teams[0]?.pilots[0]?.signToFly).toBe(true);
  });

  it("brief-complete?dryRun=true surfaces BRIEF_REQUIRED (409) and does NOT lazy-create a brief", async () => {
    const ctx = await seedRound(); // no brief seeded

    const res = await briefComplete(ctx, { dryRun: "true" });

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("BRIEF_REQUIRED");
    expect(await privateBlobExists(`round-briefs/${ctx.roundId}.json`)).toBe(false);
    expect((await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`))?.status).toBe("Confirmed");
  });

  it("brief-complete?dryRun=true surfaces an incomplete roster (409) without mutating", async () => {
    const ctx = await seedRound({ withSnapshot: false }); // Filled slot, no snapshot
    await writePrivateJson(`round-briefs/${ctx.roundId}.json`, makeBrief(ctx));

    const res = await briefComplete(ctx, { dryRun: "true" });

    expect(res.status).toBe(409);
    expect((await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`))?.status).toBe("Confirmed");
  });

  it("reopen?dryRun=true returns the currently-signed count WITHOUT changing status", async () => {
    const ctx = await seedRound({ status: "BriefComplete", signToFly: true });
    await writePrivateJson(signaturePath(ctx.roundId, ctx.teamId, 1, ctx.pilotId, 1), makeSignature(ctx, 1));

    const res = await reopen(ctx, { dryRun: "true" });

    expect(res.status).toBe(200);
    expect((res.jsonBody as { invalidatedSignatureCount: number }).invalidatedSignatureCount).toBe(1);
    expect((res.jsonBody as { status?: string }).status).toBeUndefined();

    // Round unchanged: still BriefComplete, slot still signed.
    const round = await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`);
    expect(round?.status).toBe("BriefComplete");
    expect(round?.teams[0]?.pilots[0]?.signToFly).toBe(true);
  });

  it("reopen?dryRun=true on a non-BriefComplete round → 409 (matches the real transition)", async () => {
    const ctx = await seedRound({ status: "Confirmed", signToFly: true });

    const res = await reopen(ctx, { dryRun: "true" });

    expect(res.status).toBe(409);
    expect((await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`))?.status).toBe("Confirmed");
  });

  it("after a dryRun preview, the REAL reopen still transitions to Confirmed", async () => {
    const ctx = await seedRound({ status: "BriefComplete", signToFly: true });

    const preview = await reopen(ctx, { dryRun: "true" });
    expect(preview.status).toBe(200);
    expect((preview.jsonBody as { invalidatedSignatureCount: number }).invalidatedSignatureCount).toBe(1);
    expect((await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`))?.status).toBe("BriefComplete");

    const real = await reopen(ctx);
    expect(real.status).toBe(200);
    expect((real.jsonBody as Round).status).toBe("Confirmed");
    // Real reopen invalidates nothing (Option A — signatures persist).
    expect((real.jsonBody as { invalidatedSignatureCount: number }).invalidatedSignatureCount).toBe(0);
    expect((await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`))?.status).toBe("Confirmed");
  });
});
