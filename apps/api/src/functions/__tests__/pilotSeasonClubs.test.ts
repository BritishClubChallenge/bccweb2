// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, test } from "vitest";
import { randomUUID } from "crypto";
import { makeAuthRequest, invoke } from "../../__tests__/helpers/api.js";
import { makeUser, makePilot, writePrivateJson, readPrivateJson } from "../../__tests__/helpers/seed.js";
import type { Pilot } from "@bccweb/types";
import "../pilotSeasonClubs.js"; // register handlers

function randomForwardedFor(): string {
  return `10.42.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
}

function authReq(
  user: { id: string; email: string },
  options: NonNullable<Parameters<typeof makeAuthRequest>[2]>,
) {
  return makeAuthRequest(user.id, user.email, {
    ...options,
    headers: {
      ...options.headers,
      "x-forwarded-for": randomForwardedFor(),
    },
  });
}

function retryAfterHeader(res: Awaited<ReturnType<typeof invoke>>): string | undefined {
  const headers = res.headers as Headers | Record<string, string> | undefined;
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get("Retry-After") ?? undefined;
  return headers["Retry-After"] ?? headers["retry-after"];
}

async function writePilotSeasonClubFixture(
  pilotId: string,
  seasonYear: number,
  clubId: string,
  pilotFixture?: Pilot,
): Promise<void> {
  const pilot = pilotFixture
    ? { ...pilotFixture, id: pilotId }
    : await makePilot({ id: pilotId });
  pilot.seasonClubs = [{ seasonYear, clubId, clubName: clubId }];
  await writePrivateJson(`pilots/${pilotId}.json`, pilot);
  await writePrivateJson(`season-clubs/${seasonYear}/${clubId}.json`, {
    id: `sc-${randomUUID()}`,
    seasonYear,
    clubId,
  });
  await writePrivateJson(`seasons/${seasonYear}/pilot-club-map.json`, { [pilotId]: clubId });
}

async function exhaustAssignPilotSeasonClubBucket(user: { id: string; email: string }): Promise<void> {
  const drainPilot = await makePilot({ id: "pilot-rate-assign-drain" });
  drainPilot.seasonClubs = [{ seasonYear: 2026, clubId: "00000000-0000-4000-8000-0000000000a4", clubName: "Club Rate Assign A" }];
  await writePrivateJson("pilots/pilot-rate-assign-drain.json", drainPilot);
  await writePrivateJson("clubs/00000000-0000-4000-8000-0000000000a4.json", { id: "00000000-0000-4000-8000-0000000000a4", name: "Club Rate Assign A" });
  await writePrivateJson("season-clubs/2026/00000000-0000-4000-8000-0000000000a4.json", {
    id: "sc-rate-assign-a",
    seasonYear: 2026,
    clubId: "00000000-0000-4000-8000-0000000000a4",
  });

  let exhausted = false;
  for (let i = 0; i < 60; i += 1) {
    const drainRes = await invoke(
      "assignPilotSeasonClub",
      authReq(user, {
        method: "POST",
        query: { reassign: "true" },
        body: {
          pilotId: "pilot-rate-assign-drain",
          clubId: "00000000-0000-4000-8000-0000000000a4",
          seasonYear: 2026,
        },
      }),
    );
    if (drainRes.status === 429) {
      exhausted = true;
      break;
    }
    expect(drainRes.status).toBe(201);
  }
  expect(exhausted).toBe(true);
}

async function exhaustDeletePilotSeasonClubBucket(user: { id: string; email: string }): Promise<void> {
  const pilotFixture = await makePilot({ id: "pilot-rate-delete-template" });
  let exhausted = false;
  for (let i = 0; i < 60; i += 1) {
    const pilotId = `pilot-rate-delete-drain-${i}`;
    await writePilotSeasonClubFixture(pilotId, 2026, "00000000-0000-4000-8000-0000000000a5", pilotFixture);
    const drainRes = await invoke(
      "deletePilotSeasonClub",
      authReq(user, {
        method: "DELETE",
        params: { pilotId, seasonYear: "2026" },
      }),
    );
    if (drainRes.status === 429) {
      exhausted = true;
      break;
    }
    expect(drainRes.status).toBe(204);
  }
  expect(exhausted).toBe(true);
}

describe("pilotSeasonClubs API", () => {
  test("admin lists assignments -> 200 + array", async () => {
    const { user } = await makeUser({ roles: ["Admin"] });
    await writePrivateJson("seasons/2026/pilot-club-map.json", {
      "pilot-1": "club-a",
      "pilot-2": "club-b",
    });

    const req = makeAuthRequest(user.id, user.email, {
      method: "GET",
      query: { year: "2026" },
    });
    
    const res = await invoke("getPilotSeasonClubs", req);
    expect(res.status).toBe(200);
    const body = res.jsonBody as any[];
    expect(body).toEqual([
      { pilotId: "pilot-1", clubId: "club-a", seasonYear: 2026 },
      { pilotId: "pilot-2", clubId: "club-b", seasonYear: 2026 },
    ]);
  });

  test("admin assigns pilot to registered club -> 201; pilot.seasonClubs updated; denorm map updated", async () => {
    const { user } = await makeUser({ roles: ["Admin"] });
    await makePilot({ id: "pilot-1" });
    await writePrivateJson("clubs/club-a.json", { id: "club-a", name: "Club A" });
    await writePrivateJson("season-clubs/2026/club-a.json", { id: "sc-a", seasonYear: 2026, clubId: "club-a" });

    const req = makeAuthRequest(user.id, user.email, {
      method: "POST",
      body: { pilotId: "pilot-1", clubId: "club-a", seasonYear: 2026 },
    });

    const res = await invoke("assignPilotSeasonClub", req);
    expect(res.status).toBe(201);
    
    const updatedPilot = await readPrivateJson<Pilot>("pilots/pilot-1.json");
    expect(updatedPilot!.seasonClubs).toEqual([{ seasonYear: 2026, clubId: "club-a", clubName: "Club A" }]);
    
    const map = await readPrivateJson<Record<string, string>>("seasons/2026/pilot-club-map.json");
    expect(map!["pilot-1"]).toBe("club-a");
  });

  test("assign to non-registered (year,club) -> 409", async () => {
    const { user } = await makeUser({ roles: ["Admin"] });
    await makePilot({ id: "pilot-not-reg" });

    const req = makeAuthRequest(user.id, user.email, {
      method: "POST",
      body: { pilotId: "pilot-not-reg", clubId: "club-never-registered", seasonYear: 2026 },
    });

    const res = await invoke("assignPilotSeasonClub", req);
    expect(res.status).toBe(409);
    const body = res.jsonBody;
    expect(body.code).toBe("CLUB_NOT_REGISTERED_FOR_SEASON");
  });

  test("assign to unregistered season-club preserves 409 CLUB_NOT_REGISTERED_FOR_SEASON", async () => {
    const { user } = await makeUser({ roles: ["RoundsCoord"], clubId: "00000000-0000-4000-8000-0000000000a1" });
    await makePilot({ id: "pilot-unregistered-coord" });

    const res = await invoke(
      "assignPilotSeasonClub",
      authReq(user, {
        method: "POST",
        body: {
          pilotId: "pilot-unregistered-coord",
          clubId: "00000000-0000-4000-8000-0000000000a1",
          seasonYear: 2026,
        },
      }),
    );

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code?: string }).code).toBe("CLUB_NOT_REGISTERED_FOR_SEASON");
  });

  test("assign duplicate (year, pilot) -> 409", async () => {
    const { user } = await makeUser({ roles: ["Admin"] });
    const pilot = await makePilot({ id: "pilot-dup-1" });
    pilot.seasonClubs = [{ seasonYear: 2026, clubId: "club-a", clubName: "Club A" }];
    await writePrivateJson("pilots/pilot-dup-1.json", pilot);
    await writePrivateJson("season-clubs/2026/club-b.json", { id: "sc-b", seasonYear: 2026, clubId: "club-b" });

    const req = makeAuthRequest(user.id, user.email, {
      method: "POST",
      body: { pilotId: "pilot-dup-1", clubId: "club-b", seasonYear: 2026 },
    });

    const res = await invoke("assignPilotSeasonClub", req);
    expect(res.status).toBe(409);
    const body = res.jsonBody;
    expect(body.code).toBe("PILOT_ALREADY_ASSIGNED");
  });

  test("assign duplicate with reassign flag -> 201", async () => {
    const { user } = await makeUser({ roles: ["Admin"] });
    const pilot = await makePilot({ id: "pilot-reassign" });
    pilot.seasonClubs = [{ seasonYear: 2026, clubId: "club-a", clubName: "Club A" }];
    await writePrivateJson("pilots/pilot-reassign.json", pilot);
    await writePrivateJson("clubs/club-c.json", { id: "club-c", name: "Club C" });
    await writePrivateJson("season-clubs/2026/club-c.json", { id: "sc-c", seasonYear: 2026, clubId: "club-c" });

    const req = makeAuthRequest(user.id, user.email, {
      method: "POST",
      query: { reassign: "true" },
      body: { pilotId: "pilot-reassign", clubId: "club-c", seasonYear: 2026 },
    });

    const res = await invoke("assignPilotSeasonClub", req);
    expect(res.status).toBe(201);
    
    const updatedPilot = await readPrivateJson<Pilot>("pilots/pilot-reassign.json");
    expect(updatedPilot!.seasonClubs).toEqual([{ seasonYear: 2026, clubId: "club-c", clubName: "Club C" }]);
  });

  test("RoundsCoord assigns within own club -> 201", async () => {
    const { user } = await makeUser({ roles: ["RoundsCoord"], clubId: "00000000-0000-4000-8000-0000000000a2" });
    await makePilot({ id: "pilot-coord-1" });
    await writePrivateJson("clubs/00000000-0000-4000-8000-0000000000a2.json", { id: "00000000-0000-4000-8000-0000000000a2", name: "Club Coord A" });
    await writePrivateJson("season-clubs/2026/00000000-0000-4000-8000-0000000000a2.json", { id: "sc-coord-a", seasonYear: 2026, clubId: "00000000-0000-4000-8000-0000000000a2" });

    const req = makeAuthRequest(user.id, user.email, {
      method: "POST",
      body: { pilotId: "pilot-coord-1", clubId: "00000000-0000-4000-8000-0000000000a2", seasonYear: 2026 },
    });

    const res = await invoke("assignPilotSeasonClub", req);
    expect(res.status).toBe(201);
  });

  test("RoundsCoord assigns to DIFFERENT club -> 403", async () => {
    const { user } = await makeUser({ roles: ["RoundsCoord"], clubId: "00000000-0000-4000-8000-0000000000a2" });
    
    const req = makeAuthRequest(user.id, user.email, {
      method: "POST",
      body: { pilotId: "pilot-coord-2", clubId: "00000000-0000-4000-8000-0000000000a3", seasonYear: 2026 },
    });

    const res = await invoke("assignPilotSeasonClub", req);
    expect(res.status).toBe(403);
  });

  test("RoundsCoord reassign from another club returns 403 before exhausted assign rate limit", async () => {
    const { user } = await makeUser({ roles: ["RoundsCoord"], clubId: "00000000-0000-4000-8000-0000000000a4" });
    await writePilotSeasonClubFixture("pilot-rate-assign-forbidden", 2026, "club-rate-assign-b");
    await exhaustAssignPilotSeasonClubBucket(user);

    const res = await invoke(
      "assignPilotSeasonClub",
      authReq(user, {
        method: "POST",
        query: { reassign: "true" },
        body: {
          pilotId: "pilot-rate-assign-forbidden",
          clubId: "00000000-0000-4000-8000-0000000000a4",
          seasonYear: 2026,
        },
      }),
    );

    expect(res.status).toBe(403);
    expect((res.jsonBody as { code?: string }).code).toBe("FORBIDDEN");
    expect(retryAfterHeader(res)).toBeUndefined();
  });

  test("RoundsCoord non-reassign missing pilot is rate-limited before pilot read", async () => {
    const { user } = await makeUser({ roles: ["RoundsCoord"], clubId: "00000000-0000-4000-8000-0000000000a4" });
    await exhaustAssignPilotSeasonClubBucket(user);

    const res = await invoke(
      "assignPilotSeasonClub",
      authReq(user, {
        method: "POST",
        body: {
          pilotId: "pilot-rate-assign-missing",
          clubId: "00000000-0000-4000-8000-0000000000a4",
          seasonYear: 2026,
        },
      }),
    );

    expect(res.status).toBe(429);
    expect((res.jsonBody as { code?: string }).code).toBe("RATE_LIMITED");
    expect(retryAfterHeader(res)).toBe("2");
  });

  test("DELETE removes from both pilot.seasonClubs and denorm map", async () => {
    const { user } = await makeUser({ roles: ["Admin"] });
    const pilot = await makePilot({ id: "pilot-delete" });
    pilot.seasonClubs = [{ seasonYear: 2026, clubId: "club-delete", clubName: "Club D" }];
    await writePrivateJson("pilots/pilot-delete.json", pilot);
    await writePrivateJson("seasons/2026/pilot-club-map.json", { "pilot-delete": "club-delete", "pilot-delete-2": "club-b" });

    const req = makeAuthRequest(user.id, user.email, {
      method: "DELETE",
      params: { pilotId: "pilot-delete", seasonYear: "2026" },
    });

    const res = await invoke("deletePilotSeasonClub", req);
    expect(res.status).toBe(204);

    const updatedPilot = await readPrivateJson<Pilot>("pilots/pilot-delete.json");
    expect(updatedPilot!.seasonClubs).toEqual([]);

    const map = await readPrivateJson<Record<string, string>>("seasons/2026/pilot-club-map.json");
    expect(map!["pilot-delete"]).toBeUndefined();
    expect(map!["pilot-delete-2"]).toBe("club-b");
  });

  test("Admin delete of missing season assignment remains idempotent 204", async () => {
    const { user } = await makeUser({ roles: ["Admin"] });
    await makePilot({ id: "pilot-delete-missing-assignment" });

    const res = await invoke(
      "deletePilotSeasonClub",
      authReq(user, {
        method: "DELETE",
        params: { pilotId: "pilot-delete-missing-assignment", seasonYear: "2026" },
      }),
    );

    expect(res.status).toBe(204);
  });

  test("RoundsCoord delete from another club returns 403 before exhausted delete rate limit", async () => {
    const { user } = await makeUser({ roles: ["RoundsCoord"], clubId: "00000000-0000-4000-8000-0000000000a5" });
    await writePilotSeasonClubFixture("pilot-rate-delete-forbidden", 2026, "club-rate-delete-b");
    await exhaustDeletePilotSeasonClubBucket(user);

    const res = await invoke(
      "deletePilotSeasonClub",
      authReq(user, {
        method: "DELETE",
        params: { pilotId: "pilot-rate-delete-forbidden", seasonYear: "2026" },
      }),
    );

    expect(res.status).toBe(403);
    expect((res.jsonBody as { code?: string }).code).toBe("FORBIDDEN");
    expect(retryAfterHeader(res)).toBeUndefined();
  });
});
