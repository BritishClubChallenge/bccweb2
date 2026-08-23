// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Round, RoundBrief, Signature, SignToFlyWording } from "@bccweb/types";
import { makeAuthRequest, invoke } from "../../__tests__/helpers/api.js";
import { makeUser, readPrivateJson, writePrivateJson } from "../../__tests__/helpers/seed.js";
import { signaturePath, listSignaturesForRound } from "../../lib/signTofly/ledger.js";
import { computeBriefHash } from "../../lib/signTofly/briefVersion.js";
import { reflectRoundSignToFly } from "../../lib/signTofly/reflect.js";
import { enqueueSignToFlyReflect } from "../../lib/queue.js";
import { getPrivateBlockBlobClient } from "../../lib/blob.js";

vi.mock("../../lib/queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queue.js")>()),
  enqueueSignToFlyReflect: vi.fn(),
}));

import "../signatures.js";

describe("signature endpoints", () => {
  it("pilot signs own slot -> 201 + signature blob exists at correct path; slot.signToFly = true", async () => {
    const ctx = await seedSignableRound();
    const enqueueMock = vi.mocked(enqueueSignToFlyReflect);

    const res = await sign(ctx);

    expect(res.status).toBe(201);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith({ roundId: ctx.roundId });
    const sig = res.jsonBody as Signature;
    expect(sig.pilotId).toBe(ctx.pilotId);
    expect(sig.ip).toBe("203.0.113.10");
    expect(await readPrivateJson<Signature>(signaturePath(ctx.roundId, ctx.teamId, 1, ctx.pilotId, 1))).toEqual(sig);
    await reflectRoundSignToFly(ctx.roundId);
    const round = await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`);
    expect(round?.teams[0].pilots[0].signToFly).toBe(true);
  });

  it("missing active wording pointer fails explicitly with 503 WORDING_NOT_SEEDED", async () => {
    const ctx = await seedSignableRound();
    await getPrivateBlockBlobClient("sign-to-fly/wording/active.json").deleteIfExists();

    const res = await sign(ctx);

    expect(res.status).toBe(503);
    expect((res.jsonBody as { code: string }).code).toBe("WORDING_NOT_SEEDED");
  });

  it("pilot tries to sign another pilot's slot -> 403 NOT_YOUR_SLOT", async () => {
    const ctx = await seedSignableRound();
    const { user } = await makeUser({ roles: ["Pilot"], pilotId: randomUUID() });

    const res = await sign(ctx, user.id, user.email);

    expect(res.status).toBe(403);
    expect((res.jsonBody as { code: string }).code).toBe("NOT_YOUR_SLOT");
  });

  it("admin/coord tries to sign ANOTHER pilot's slot -> 403 NOT_YOUR_SLOT_USE_OVERRIDE", async () => {
    const ctx = await seedSignableRound();
    const { user } = await makeUser({ roles: ["Admin"], pilotId: randomUUID() });

    const res = await sign(ctx, user.id, user.email);

    expect(res.status).toBe(403);
    expect((res.jsonBody as { code: string }).code).toBe("NOT_YOUR_SLOT_USE_OVERRIDE");
  });

  it("admin/coord who OWNS the slot self-signs -> 201 (role never blocks own-slot sign)", async () => {
    const ctx = await seedSignableRound();
    const { user } = await makeUser({ roles: ["Admin", "Pilot"], pilotId: ctx.pilotId });

    const res = await sign(ctx, user.id, user.email);

    expect(res.status).toBe(201);
    expect((res.jsonBody as Signature).pilotId).toBe(ctx.pilotId);
  });

  it("admin who is ALSO a pilot but does NOT own the slot -> 403 NOT_YOUR_SLOT_USE_OVERRIDE (isSelf must be per-slot, not per-role)", async () => {
    const ctx = await seedSignableRound();
    const { user } = await makeUser({ roles: ["Admin", "Pilot"], pilotId: randomUUID() });

    const res = await sign(ctx, user.id, user.email);

    expect(res.status).toBe(403);
    expect((res.jsonBody as { code: string }).code).toBe("NOT_YOUR_SLOT_USE_OVERRIDE");
  });

  it("same pilot signs same brief version twice -> 200/201 idempotent (same signature returned)", async () => {
    const ctx = await seedSignableRound();

    const first = await sign(ctx);
    const second = await sign(ctx);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.jsonBody).toEqual(first.jsonBody);
  });

  it("roster swap after signing: new occupant self-signs -> gets own signature, not the former occupant's (regression #260)", async () => {
    const ctx = await seedSignableRound();
    const first = await sign(ctx);
    expect(first.status).toBe(201);

    // Simulate a coordinator roster swap: pilot B replaces pilot A in the
    // slot. Brief version is untouched — team rosters are not a
    // MATERIAL_BRIEF_FIELDS entry — reproducing issue #260 exactly.
    const pilotBId = randomUUID();
    const { user: pilotBUser } = await makeUser({ roles: ["Pilot"], pilotId: pilotBId });
    const round = (await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`))!;
    round.teams[0].pilots[0].pilotId = pilotBId;
    round.teams[0].pilots[0].snapshot = null;
    round.teams[0].pilots[0].signToFly = false;
    round.teams[0].pilots[0].accountedFor = false;
    await writePrivateJson(`rounds/${ctx.roundId}.json`, round);

    const second = await sign(ctx, pilotBUser.id, pilotBUser.email);

    expect(second.status).toBe(201);
    const secondSig = second.jsonBody as Signature;
    expect(secondSig.pilotId).toBe(pilotBId);
    expect(secondSig.userId).toBe(pilotBUser.id);
    expect(secondSig.id).not.toBe((first.jsonBody as Signature).id);

    const forSlot = (await listSignaturesForRound(ctx.roundId)).filter(
      (s) => s.teamId === ctx.teamId && s.place === 1,
    );
    expect(forSlot).toHaveLength(2);
    expect(forSlot.map((s) => s.pilotId).sort()).toEqual([ctx.pilotId, pilotBId].sort());
  });

  it("double roster swap: pilot who returns to a slot they previously signed is recognized as signed again (regression: double roster swap)", async () => {
    const ctx = await seedSignableRound();
    const originalPilotId = ctx.pilotId;
    const first = await sign(ctx);
    expect(first.status).toBe(201);

    const pilotBId = randomUUID();
    const { user: pilotBUser } = await makeUser({ roles: ["Pilot"], pilotId: pilotBId });
    let round = (await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`))!;
    round.teams[0].pilots[0].pilotId = pilotBId;
    round.teams[0].pilots[0].snapshot = null;
    round.teams[0].pilots[0].signToFly = false;
    round.teams[0].pilots[0].accountedFor = false;
    await writePrivateJson(`rounds/${ctx.roundId}.json`, round);

    const second = await sign(ctx, pilotBUser.id, pilotBUser.email);
    expect(second.status).toBe(201);

    round = (await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`))!;
    round.teams[0].pilots[0].pilotId = originalPilotId;
    round.teams[0].pilots[0].snapshot = null;
    round.teams[0].pilots[0].signToFly = false;
    round.teams[0].pilots[0].accountedFor = false;
    await writePrivateJson(`rounds/${ctx.roundId}.json`, round);

    // The original pilot's self-sign hits their OWN pre-existing v1 blob
    // from `first` -> 200, not a new write (they already hold a valid
    // signature for the still-frozen v1 brief). What must be proven is
    // that the reflect/lock-gate logic recognizes it as CURRENT.
    const third = await sign(ctx, ctx.userId, ctx.email);
    expect(third.status).toBe(200);
    expect((third.jsonBody as Signature).pilotId).toBe(originalPilotId);

    await reflectRoundSignToFly(ctx.roundId);
    const finalRound = await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`);
    expect(finalRound?.teams[0].pilots[0].signToFly).toBe(true);
  });

  it("brief version bumps after first sign -> second sign creates NEW record; old record preserved on disk", async () => {
    const ctx = await seedSignableRound();

    const first = await sign(ctx);
    await seedBrief(ctx.roundId, 2);
    const second = await sign(ctx);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((second.jsonBody as Signature).briefVersion).toBe(2);
    expect((second.jsonBody as Signature).id).not.toBe((first.jsonBody as Signature).id);
    expect(await readPrivateJson<Signature>(signaturePath(ctx.roundId, ctx.teamId, 1, ctx.pilotId, 1))).toEqual(first.jsonBody);
    expect(await readPrivateJson<Signature>(signaturePath(ctx.roundId, ctx.teamId, 1, ctx.pilotId, 2))).toEqual(second.jsonBody);
  });

  it("round status not BriefComplete -> 409 INVALID_STATE", async () => {
    const ctx = await seedSignableRound({ status: "Confirmed" });

    const res = await sign(ctx);

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string; detail: string }).code).toBe("INVALID_STATE");
    expect((res.jsonBody as { detail: string }).detail).toContain("Confirmed");
  });

  it("slot empty -> 409 SLOT_EMPTY", async () => {
    const ctx = await seedSignableRound({ slotStatus: "Empty" });

    const res = await sign(ctx);

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string }).code).toBe("SLOT_EMPTY");
  });

  it("GET /signatures returns all versions ordered", async () => {
    const ctx = await seedSignableRound();
    await sign(ctx);
    await seedBrief(ctx.roundId, 2);
    await sign(ctx);
    const { user } = await makeUser({ roles: ["Admin"] });

    const res = await invoke(
      "getRoundSignatures",
      makeAuthRequest(user.id, user.email, {
        method: "GET",
        params: { roundId: ctx.roundId },
      }),
    );

    expect(res.status).toBe(200);
    expect((res.jsonBody as Signature[]).map((sig) => sig.briefVersion)).toEqual([1, 2]);
  });
});

interface SignContext {
  roundId: string;
  teamId: string;
  pilotId: string;
  userId: string;
  email: string;
}

async function seedSignableRound(overrides: {
  status?: Round["status"];
  slotStatus?: "Empty" | "Filled";
} = {}): Promise<SignContext> {
  await seedWording();
  const pilotId = randomUUID();
  const { user } = await makeUser({ roles: ["Pilot"], pilotId });
  const roundId = randomUUID();
  const teamId = randomUUID();
  const round: Round = {
    id: roundId,
    date: "2026-06-09",
    status: overrides.status ?? "BriefComplete",
    isLocked: false,
    maxTeams: 8,
    minimumScore: 0,
    site: { id: randomUUID(), name: "Milk Hill" },
    organisingClub: { id: randomUUID(), name: "Test Club" },
    season: { year: 2026 },
    teams: [{
      id: teamId,
      teamName: "A",
      club: { id: randomUUID(), name: "Test Club" },
      score: 0,
      pilots: [{
        placeInTeam: 1,
        isScoring: true,
        status: overrides.slotStatus ?? "Filled",
        accountedFor: false,
        signToFly: false,
        noScore: false,
        pilotPoints: 0,
        pilotId,
        snapshot: null,
        flight: null,
      }],
    }],
  };
  await writePrivateJson(`rounds/${roundId}.json`, round);
  await seedBrief(roundId, 1);
  return { roundId, teamId, pilotId, userId: user.id, email: user.email };
}

async function sign(ctx: SignContext, userId = ctx.userId, email = ctx.email) {
  return invoke(
    "signOwnSlot",
    makeAuthRequest(userId, email, {
      method: "POST",
      params: { roundId: ctx.roundId, teamId: ctx.teamId, place: "1" },
      headers: {
        "x-forwarded-for": "10.0.0.1, 203.0.113.10",
        "user-agent": "vitest-agent",
      },
    }),
  );
}

async function seedWording(): Promise<void> {
  const markdown = "Sign to fly wording";
  const wording: SignToFlyWording = {
    version: 1,
    hash: createHash("sha256").update(markdown, "utf8").digest("hex"),
    markdown,
    createdAt: new Date().toISOString(),
    createdBy: "vitest",
  };
  await writePrivateJson("sign-to-fly/wording/1.json", wording);
  await writePrivateJson("sign-to-fly/wording/active.json", { activeVersion: 1 });
}

// Frozen brief: signOwnSlot's G2 gate requires hash === computeBriefHash(brief).
async function seedBrief(roundId: string, version: number): Promise<void> {
  const brief: RoundBrief & { version: number } = {
    roundId,
    version,
    generatedAt: new Date().toISOString(),
    date: "2026-06-09",
    siteName: "Milk Hill",
    briefingTime: "10:00",
    landByTime: "18:00",
    checkInByTime: "19:00",
    windSpeedDirection: `W ${version}`,
    imagePaths: [],
    teams: [],
  };
  brief.hash = computeBriefHash(brief);
  await writePrivateJson(`round-briefs/${roundId}.json`, brief);
}
