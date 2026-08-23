// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Round, RoundBrief, Signature, SignToFlyWording } from "@bccweb/types";
import { makeAuthRequest, invoke } from "../../__tests__/helpers/api.js";
import { makeUser, readPrivateJson, writePrivateJson } from "../../__tests__/helpers/seed.js";
import { getPrivateContainer } from "../../__tests__/helpers/azurite.js";
import { signaturePath, writeSignature } from "../../lib/signTofly/ledger.js";
import { computeBriefHash } from "../../lib/signTofly/briefVersion.js";
import { reflectRoundSignToFly } from "../../lib/signTofly/reflect.js";
import { enqueueSignToFlyReflect } from "../../lib/queue.js";

vi.mock("../../lib/queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queue.js")>()),
  enqueueSignToFlyReflect: vi.fn(),
}));

import "../signatures.js";

describe("signature override endpoint", () => {
  it("admin can override -> 201 with source:'coord-override', overrideReason, overrideBy", async () => {
    const ctx = await seedSignableRound();
    const { user: admin } = await makeUser({ roles: ["Admin"] });
    const enqueueMock = vi.mocked(enqueueSignToFlyReflect);

    const res = await overrideSign(ctx, admin.id, admin.email);

    expect(res.status).toBe(201);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith({ roundId: ctx.roundId });
    expect(res.jsonBody).toMatchObject({
      source: "coord-override",
      overrideReason: VALID_REASON,
      overrideBy: admin.id,
      userId: admin.id,
      pilotId: ctx.pilotId,
    });
    await reflectRoundSignToFly(ctx.roundId);
    const round = await readPrivateJson<Round>(`rounds/${ctx.roundId}.json`);
    expect(round?.teams[0].pilots[0].signToFly).toBe(true);
  });

  it("RoundsCoord scoped to round's club can override -> 201", async () => {
    const ctx = await seedSignableRound();
    const { user: coord } = await makeUser({ roles: ["RoundsCoord"], clubId: ctx.clubId });

    const res = await overrideSign(ctx, coord.id, coord.email);

    expect(res.status).toBe(201);
    expect((res.jsonBody as Signature).overrideBy).toBe(coord.id);
  });

  it("RoundsCoord scoped to DIFFERENT club -> 403", async () => {
    const ctx = await seedSignableRound();
    const { user: coord } = await makeUser({ roles: ["RoundsCoord"], clubId: randomUUID() });

    const res = await overrideSign(ctx, coord.id, coord.email);

    expect(res.status).toBe(403);
    expect((res.jsonBody as { code: string }).code).toBe("FORBIDDEN");
  });

  it("pilot cannot call override -> 403", async () => {
    const ctx = await seedSignableRound();
    const { user: pilot } = await makeUser({ roles: ["Pilot"], pilotId: ctx.pilotId });

    const res = await overrideSign(ctx, pilot.id, pilot.email);

    expect(res.status).toBe(403);
    expect((res.jsonBody as { code: string }).code).toBe("FORBIDDEN");
  });

  it("reason < 20 chars -> 400 INVALID_REASON", async () => {
    const ctx = await seedSignableRound();
    const { user: admin } = await makeUser({ roles: ["Admin"] });

    const res = await overrideSign(ctx, admin.id, admin.email, { reason: "too short" });

    expect(res.status).toBe(400);
    expect((res.jsonBody as { code: string; detail: string }).code).toBe("INVALID_REASON");
    expect((res.jsonBody as { detail: string }).detail).toBe("Reason must be at least 20 characters");
  });

  it("onBehalfOfPilotId mismatch -> 400 PILOT_MISMATCH", async () => {
    const ctx = await seedSignableRound();
    const { user: admin } = await makeUser({ roles: ["Admin"] });

    const res = await overrideSign(ctx, admin.id, admin.email, { onBehalfOfPilotId: randomUUID() });

    expect(res.status).toBe(400);
    expect((res.jsonBody as { code: string; detail: string }).code).toBe("PILOT_MISMATCH");
    expect((res.jsonBody as { detail: string }).detail).toBe("onBehalfOfPilotId does not match the slot's assigned pilot");
  });

  it("round not BriefComplete -> 409 INVALID_STATE", async () => {
    const ctx = await seedSignableRound({ status: "Confirmed" });
    const { user: admin } = await makeUser({ roles: ["Admin"] });

    const res = await overrideSign(ctx, admin.id, admin.email);

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string; detail: string }).code).toBe("INVALID_STATE");
    expect((res.jsonBody as { detail: string }).detail).toContain("Confirmed");
  });

  it("audit log line appended; readable; contains expected fields", async () => {
    const ctx = await seedSignableRound();
    const { user: admin } = await makeUser({ roles: ["Admin"] });

    const res = await overrideSign(ctx, admin.id, admin.email);
    const audit = await readAuditLines();

    expect(res.status).toBe(201);
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: (res.jsonBody as Signature).id,
        source: "coord-override",
        overrideReason: VALID_REASON,
        overrideBy: admin.id,
        audit: expect.objectContaining({
          originalSignaturePathIfAny: null,
          pilotAndCoordSigned: false,
        }),
      }),
    ]));
  });

  it("override + existing pilot-self signature -> both records present on disk, audit notes the existing", async () => {
    const ctx = await seedSignableRound();
    const { user: admin } = await makeUser({ roles: ["Admin"] });
    const pilotSig = makePilotSignature(ctx);
    await writeSignature(pilotSig);

    const res = await overrideSign(ctx, admin.id, admin.email);
    const listed = [] as string[];
    for await (const item of getPrivateContainer().listBlobsFlat({ prefix: `signatures/${ctx.roundId}/` })) {
      listed.push(item.name);
    }
    const audit = await readAuditLines();

    expect(res.status).toBe(201);
    expect(await readPrivateJson<Signature>(signaturePath(ctx.roundId, ctx.teamId, 1, ctx.pilotId, 1))).toEqual(pilotSig);
    expect(listed.filter((path) => path.includes(`${ctx.teamId}-1-${ctx.pilotId}-v1`))).toHaveLength(2);
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: (res.jsonBody as Signature).id,
        audit: expect.objectContaining({
          originalSignaturePathIfAny: signaturePath(ctx.roundId, ctx.teamId, 1, ctx.pilotId, 1),
          originalSignatureSourceIfAny: "pilot-self",
          pilotAndCoordSigned: true,
        }),
      }),
    ]));
  });
});

const VALID_REASON = "Pilot signed paper form at the field before launch";

interface SignContext {
  roundId: string;
  teamId: string;
  pilotId: string;
  clubId: string;
}

async function seedSignableRound(overrides: { status?: Round["status"] } = {}): Promise<SignContext> {
  await seedWording();
  const pilotId = randomUUID();
  const roundId = randomUUID();
  const teamId = randomUUID();
  const clubId = randomUUID();
  const round: Round = {
    id: roundId,
    date: "2026-06-09",
    status: overrides.status ?? "BriefComplete",
    isLocked: false,
    maxTeams: 8,
    minimumScore: 0,
    site: { id: randomUUID(), name: "Milk Hill" },
    organisingClub: { id: clubId, name: "Test Club" },
    season: { year: 2026 },
    teams: [{
      id: teamId,
      teamName: "A",
      club: { id: clubId, name: "Test Club" },
      score: 0,
      pilots: [{
        placeInTeam: 1,
        isScoring: true,
        status: "Filled",
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
  return { roundId, teamId, pilotId, clubId };
}

async function overrideSign(
  ctx: SignContext,
  userId: string,
  email: string,
  body: Partial<{ reason: string; onBehalfOfPilotId: string }> = {},
) {
  return invoke(
    "overrideSlotSignature",
    makeAuthRequest(userId, email, {
      method: "POST",
      params: { roundId: ctx.roundId, teamId: ctx.teamId, place: "1" },
      body: {
        reason: body.reason ?? VALID_REASON,
        onBehalfOfPilotId: body.onBehalfOfPilotId ?? ctx.pilotId,
      },
      headers: {
        "x-forwarded-for": "203.0.113.20, 10.0.0.1",
        "user-agent": "override-test-agent",
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

// Frozen brief: override path shares signOwnSlot's G2 hash gate.
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

function makePilotSignature(ctx: SignContext): Signature {
  return {
    id: randomUUID(),
    roundId: ctx.roundId,
    teamId: ctx.teamId,
    place: 1,
    pilotId: ctx.pilotId,
    userId: randomUUID(),
    signedAt: new Date().toISOString(),
    briefVersion: 1,
    briefHash: "brief-hash",
    wordingVersion: 1,
    wordingHash: "wording-hash",
    ip: "203.0.113.10",
    userAgent: "pilot-agent",
    source: "pilot-self",
  };
}

async function readAuditLines(): Promise<Array<Record<string, unknown>>> {
  const prefix = `audit/sign-override-${new Date().toISOString().slice(0, 10)}.jsonl`;
  const response = await getPrivateContainer().getBlobClient(prefix).download();
  const chunks: Buffer[] = [];
  for await (const chunk of response.readableStreamBody!) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks)
    .toString("utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
