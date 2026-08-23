// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import type { Round, Signature } from "@bccweb/types";
import { describe, expect, it } from "vitest";
import { readPrivateJson } from "../../__tests__/helpers/seed.js";
import {
  signaturePath,
  writeSignature,
} from "../../lib/signTofly/ledger.js";
import {
  makeSignature,
  seedRegistrationRound,
  unregister,
} from "./roundRegistration.testHelpers.js";
import "../roundRegistration.js";

describe("round self-unregistration endpoint", () => {
  it("unregister before signing -> 200; slot emptied", async () => {
    const ctx = await seedRegistrationRound({
      teamSlots: [{ placeInTeam: 1, pilotId: "self" }],
    });
    const res = await unregister(ctx);
    expect(res.status).toBe(200);
    expect(res.jsonBody).toMatchObject({
      removedFromTeamId: ctx.team.id,
      removedFromPlace: 1,
    });
    const round = await readPrivateJson<Round>(`rounds/${ctx.round.id}.json`);
    expect(round?.teams[0].pilots[0]).toMatchObject({
      status: "Empty",
      pilotId: null,
      snapshot: null,
    });
  });

  it("unregister after signing -> 409 SIGNED_CONTACT_COORD", async () => {
    const ctx = await seedRegistrationRound({
      teamSlots: [{ placeInTeam: 1, pilotId: "self" }],
    });
    const signature = makeSignature(ctx);
    await writeSignature(signature);
    const res = await unregister(ctx);
    expect(res.status).toBe(409);
    expect((res.jsonBody as { code: string; detail: string }).code).toBe(
      "SIGNED_CONTACT_COORD"
    );
    expect(
      await readPrivateJson<Signature>(
        signaturePath(ctx.round.id, ctx.team.id, 1, signature.pilotId, 1)
      )
    ).toEqual(signature);
  });
});
