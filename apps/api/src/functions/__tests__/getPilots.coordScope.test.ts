// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, test } from "vitest";
import type { PilotSummary } from "@bccweb/types";
import { makeAuthRequest, makeRequest, invoke } from "../../__tests__/helpers/api.js";
import { makeUser, writePublicJson } from "../../__tests__/helpers/seed.js";
import "../pilots.js";

function pilotIds(body: unknown): string[] {
  return (body as PilotSummary[]).map((pilot) => pilot.id);
}

describe("GET /api/pilots — coord scoping", () => {
  test("RoundsCoord sees only pilots from own club", async () => {
    await writePublicJson<PilotSummary[]>("pilots.json", [
      { id: "pilot-club-c", legacyId: null, name: "Club C Pilot", clubId: "00000000-0000-4000-8000-00000000000c" },
      { id: "pilot-club-d", legacyId: null, name: "Club D Pilot", clubId: "00000000-0000-4000-8000-00000000000d" },
    ]);

    const { user } = await makeUser({
      roles: ["RoundsCoord"],
      clubId: "00000000-0000-4000-8000-00000000000c",
      emailVerified: true,
    });

    const res = await invoke("getPilots", makeAuthRequest(user.id, user.email, { method: "GET" }));

    expect(res.status).toBe(200);
    expect(pilotIds(res.jsonBody)).toEqual(["pilot-club-c"]);
  });

  test("Admin sees all pilots", async () => {
    await writePublicJson<PilotSummary[]>("pilots.json", [
      { id: "pilot-club-c", legacyId: null, name: "Club C Pilot", clubId: "00000000-0000-4000-8000-00000000000c" },
      { id: "pilot-club-d", legacyId: null, name: "Club D Pilot", clubId: "00000000-0000-4000-8000-00000000000d" },
    ]);

    const { user: admin } = await makeUser({ roles: ["Admin"], emailVerified: true });

    const res = await invoke("getPilots", makeAuthRequest(admin.id, admin.email, { method: "GET" }));

    expect(res.status).toBe(200);
    expect(pilotIds(res.jsonBody)).toEqual(["pilot-club-c", "pilot-club-d"]);
  });

  test("Unauthenticated request is rejected with 401", async () => {
    await writePublicJson<PilotSummary[]>("pilots.json", [
      { id: "pilot-club-c", legacyId: null, name: "Club C Pilot", clubId: "00000000-0000-4000-8000-00000000000c" },
      { id: "pilot-club-d", legacyId: null, name: "Club D Pilot", clubId: "00000000-0000-4000-8000-00000000000d" },
    ]);

    const res = await invoke("getPilots", makeRequest({ method: "GET" }));

    expect(res.status).toBe(401);
  });
});
