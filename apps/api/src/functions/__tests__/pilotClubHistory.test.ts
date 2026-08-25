// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, it, expect } from "vitest";
import type { PilotClubMembership } from "@bccweb/types";
import { makeAuthRequest, invoke } from "../../__tests__/helpers/api.js";
import { makeUser, makePilot, writePrivateJson } from "../../__tests__/helpers/seed.js";
import "../pilots.js";

describe("GET /api/pilots/{id}/club-history", () => {
  it("pilot fetches own history -> 200 + array", async () => {
    const pilot = await makePilot();
    const { user } = await makeUser({ roles: ["Pilot"], pilotId: pilot.id });
    const history: PilotClubMembership[] = [
      {
        pilotId: pilot.id,
        clubId: "club-uuid-test",
        clubName: "Test Club",
        joinedAt: "2010-01-01T00:00:00.000Z",
        leftAt: null,
        source: "legacy",
        legacyId: 42,
      },
    ];
    await writePrivateJson(`pilots/${pilot.id}/club-history.json`, history);

    const req = makeAuthRequest(user.id, user.email, { params: { id: pilot.id } });
    const res = await invoke("getPilotClubHistory", req);

    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual(history);
  });

  it("pilot fetches another pilot's history -> 403", async () => {
    const otherPilot = await makePilot();
    const { user } = await makeUser({ roles: ["Pilot"], pilotId: "00000000-0000-4000-8000-0000000000b1" });

    const req = makeAuthRequest(user.id, user.email, { params: { id: otherPilot.id } });
    const res = await invoke("getPilotClubHistory", req);

    expect(res.status).toBe(403);
  });

  it("admin fetches any pilot history -> 200", async () => {
    const pilot = await makePilot();
    const { user } = await makeUser({ roles: ["Admin"] });
    const history: PilotClubMembership[] = [
      {
        pilotId: pilot.id,
        clubId: "club-uuid-any",
        clubName: "Any Club",
        joinedAt: null,
        leftAt: null,
        source: "current",
      },
    ];
    await writePrivateJson(`pilots/${pilot.id}/club-history.json`, history);

    const req = makeAuthRequest(user.id, user.email, { params: { id: pilot.id } });
    const res = await invoke("getPilotClubHistory", req);

    expect(res.status).toBe(200);
    const body = res.jsonBody as PilotClubMembership[];
    expect(body[0].source).toBe("current");
  });

  it("no history blob -> 404 NOT_FOUND", async () => {
    const pilot = await makePilot();
    const { user } = await makeUser({ roles: ["Admin"] });

    const req = makeAuthRequest(user.id, user.email, { params: { id: pilot.id } });
    const res = await invoke("getPilotClubHistory", req);

    expect(res.status).toBe(404);
    expect((res.jsonBody as { code: string }).code).toBe("NOT_FOUND");
  });
});
