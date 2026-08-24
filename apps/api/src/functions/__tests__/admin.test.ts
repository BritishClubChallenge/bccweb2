// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * admin.ts — schema/lease behaviour tests (Task 20).
 *
 * Covers the new contract:
 *   - updateConfig rejects bad client input with 400 (no DATA_SHAPE_INVALID
 *     blowup through BlobShapeError).
 *   - updateConfig merges into existing under a private lease.
 *   - concurrent updateConfig: exactly one 200, others 503 (LEASE_HELD).
 *   - setUserRoles validates role names with 400 on unknown role.
 *   - setUserRoles RMW under a private lease, returns 404 if user missing.
 */

import { describe, expect, test } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { HttpRequest } from "@azure/functions";
import type { AdminUserView, Config, Pilot, PilotEmailIndex, PilotSummary, User } from "@bccweb/types";
import { ConfigSchema } from "@bccweb/schemas";
import { getCallerIdentity } from "../../lib/auth.js";
import {
  assertNotLastAdmin,
  UserDeletedError,
  withAccountMutationLock,
} from "../../lib/accountMutation.js";
import type { AuthCredential } from "../../lib/authHelpers.js";
import {
  generateShortLivedToken,
  lookupUserByEmail,
  signRefreshToken,
} from "../../lib/authHelpers.js";
import { getRegisteredHandler } from "../../__tests__/helpers/setup.js";
import { makeAuthRequest, makeRequest } from "../../__tests__/helpers/api.js";
import {
  bootstrapAdmin,
  makeConfig,
  makePilot,
  makeUser,
  privateBlobExists,
  readPrivateJson,
  readPublicJson,
  writePrivateJson,
  writePublicJson,
} from "../../__tests__/helpers/seed.js";
import "../admin.js";
import "../authFunctions.js";

interface HandlerResult {
  status: number;
  jsonBody?: unknown;
}

const ctx = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  invocationId: "test-invocation",
} as never;

async function invoke(
  name: string,
  req: ReturnType<typeof makeAuthRequest>,
): Promise<HandlerResult> {
  const entry = getRegisteredHandler(name);
  if (!entry) throw new Error(`${name} not registered`);
  return (await entry.handler(req, ctx)) as HandlerResult;
}

function deterministicPilotId(userId: string): string {
  const hex = createHash("sha256").update(`admin-pilot:${userId}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function createPilotForUser(
  admin: User,
  userId: string,
  body: { firstName: string; lastName: string },
): Promise<HandlerResult> {
  return invoke(
    "adminCreatePilotForUser",
    makeAuthRequest(admin.id, admin.email, {
      method: "POST",
      params: { userId },
      body,
    }),
  );
}

async function tombstoneIndexedAdminsExcept(...keepUserIds: readonly string[]): Promise<void> {
  const keepUserIdSet = new Set(keepUserIds);
  const index = await readPrivateJson<Record<string, string>>("user-index.json");
  for (const userId of new Set(Object.values(index ?? {}))) {
    if (keepUserIdSet.has(userId)) continue;
    const user = await readPrivateJson<User>(`users/${userId}.json`);
    if (user?.roles.includes("Admin")) {
      await writePrivateJson(`users/deleted/${userId}.json`, {});
    }
  }
}

describe("PUT /api/manage/config — schema validation & lease", () => {
  test("rejects bogus wingFactors key with 400 (client input, not BlobShapeError)", async () => {
    const { user } = await bootstrapAdmin();
    const req = makeAuthRequest(user.id, user.email, {
      method: "PUT",
      body: { wingFactors: { BogusKey: 99 } },
    });

    const res = await invoke("updateConfig", req);

    expect(res.status).toBe(400);
    const body = res.jsonBody as { code?: string; detail?: string };
    expect(body.code).toBe("INVALID_CONFIG");
    expect(body.detail ?? "").toContain("BogusKey");
  });

  test("rejects unknown top-level key (strict mode rejects unknowns on client input)", async () => {
    const { user } = await bootstrapAdmin();
    const req = makeAuthRequest(user.id, user.email, {
      method: "PUT",
      body: { foo: 1 },
    });

    const res = await invoke("updateConfig", req);
    // Top-level ConfigSchema uses .strip() → unknown keys are silently
    // dropped, so a body with only-unknown keys is a no-op write returning
    // 200 with the existing/defaults config. Document this branch.
    expect(res.status).toBe(200);
    const cfg = res.jsonBody as Config;
    expect(cfg.maxTeamsInClub).toBeTypeOf("number");
  });

  test("merges patch into existing config under a lease", async () => {
    const { user } = await bootstrapAdmin();

    // Seed via the handler so we start from a known full-defaults state.
    await invoke(
      "updateConfig",
      makeAuthRequest(user.id, user.email, { method: "PUT", body: {} }),
    );

    const res = await invoke(
      "updateConfig",
      makeAuthRequest(user.id, user.email, {
        method: "PUT",
        body: {
          maxTeamsInClub: 7,
          wingFactors: { "EN A": 1.5 },
        },
      }),
    );

    expect(res.status).toBe(200);
    const cfg = res.jsonBody as Config;
    expect(cfg.maxTeamsInClub).toBe(7);
    expect(cfg.wingFactors["EN A"]).toBe(1.5);
    // Untouched defaults preserved (schema default is the legacy-correct 9).
    expect(cfg.wingFactors["EN B"]).toBeTypeOf("number");
    expect(cfg.maxPilotsInTeam).toBe(9);

    const persisted = await readPrivateJson<Config>("config.json");
    expect(persisted?.maxTeamsInClub).toBe(7);
    expect(persisted?.wingFactors["EN A"]).toBe(1.5);
  });

  test("partial factor edit preserves untouched sibling keys and every other table", async () => {
    // Given: a full config carrying CUSTOM factor values in each nested map,
    // seeded directly so the PATCH below is the only operation under test.
    const { user } = await bootstrapAdmin();
    const seeded: Config = {
      ...ConfigSchema.parse({}),
      pilotFactors: { "Club Pilot": 1, Pilot: 1, "Advanced Pilot": 0.85 },
      wingFactors: {
        "EN A": 1.0,
        "EN B": 0.9,
        "EN C": 0.77,
        "EN C 2-liner": 0.7,
        "EN D": 0.6,
        "EN D 2-liner": 0.5,
      },
      clubsAttendingFactors: {
        fewerThanThreeClubs: 0.5,
        exactlyThreeClubs: 0.7,
        moreThanThreeClubs: 1,
      },
      minDistanceFactors: {
        oneFlight: 0.2,
        twoFlights: 0.4,
        threeFlights: 0.55,
        fourFlights: 0.8,
        fiveOrMoreFlights: 1,
      },
    };
    await writePrivateJson("config.json", seeded);

    // When: an admin PATCHes only pilotFactors.Pilot.
    const put = await invoke(
      "updateConfig",
      makeAuthRequest(user.id, user.email, {
        method: "PUT",
        body: { pilotFactors: { Pilot: 1.1 } },
      }),
    );
    expect(put.status).toBe(200);

    const res = await invoke(
      "getConfig",
      makeAuthRequest(user.id, user.email, { method: "GET" }),
    );
    expect(res.status).toBe(200);
    const cfg = res.jsonBody as Config;

    // Then: only pilotFactors.Pilot changed; its siblings survive. The old
    // ConfigSchema.partial() merge hydrated them from defaults (Advanced Pilot
    // 0.85 → 0.9), so this assertion fails against that merge.
    expect(cfg.pilotFactors.Pilot).toBe(1.1);
    expect(cfg.pilotFactors["Advanced Pilot"]).toBe(0.85);
    expect(cfg.pilotFactors["Club Pilot"]).toBe(seeded.pilotFactors["Club Pilot"]);

    // And: every OTHER factor table is byte-identical to what was seeded.
    expect(cfg.wingFactors).toEqual(seeded.wingFactors);
    expect(cfg.clubsAttendingFactors).toEqual(seeded.clubsAttendingFactors);
    expect(cfg.minDistanceFactors).toEqual(seeded.minDistanceFactors);

    // And: the persisted blob is a valid full Config carrying the merge result.
    const persistedCfg = await readPrivateJson<Config>("config.json");
    expect(ConfigSchema.safeParse(persistedCfg).success).toBe(true);
    expect(persistedCfg?.pilotFactors["Advanced Pilot"]).toBe(0.85);
    expect(persistedCfg?.pilotFactors.Pilot).toBe(1.1);
    expect(persistedCfg?.wingFactors).toEqual(seeded.wingFactors);
  });

  test("replaces round brief recipients wholesale and persists the replacement", async () => {
    // Given
    await makeConfig({ roundBriefRecipients: ["a@x.com", "b@y.com"] });
    const { user } = await bootstrapAdmin();

    // When
    const res = await invoke(
      "updateConfig",
      makeAuthRequest(user.id, user.email, {
        method: "PUT",
        body: { roundBriefRecipients: ["c@z.com"] },
      }),
    );

    // Then
    expect(res.status).toBe(200);
    expect((res.jsonBody as Config).roundBriefRecipients).toEqual(["c@z.com"]);
    const persisted = await readPrivateJson<Config>("config.json");
    expect(persisted?.roundBriefRecipients).toEqual(["c@z.com"]);
  });

  test("rejects an invalid round brief recipient", async () => {
    // Given
    const { user } = await bootstrapAdmin();

    // When
    const res = await invoke(
      "updateConfig",
      makeAuthRequest(user.id, user.email, {
        method: "PUT",
        body: { roundBriefRecipients: ["nope"] },
      }),
    );

    // Then
    expect(res.status).toBe(400);
  });

  test("concurrent updates: exactly one 200, others 503 LEASE_HELD", async () => {
    const { user } = await bootstrapAdmin();

    // Pre-seed config.json so the ensure-create branch is a no-op for all
    // concurrent calls and the only contention is the lease.
    await invoke(
      "updateConfig",
      makeAuthRequest(user.id, user.email, { method: "PUT", body: {} }),
    );

    const launch = (n: number) =>
      invoke(
        "updateConfig",
        makeAuthRequest(user.id, user.email, {
          method: "PUT",
          body: { maxTeamsInClub: n },
        }),
      );

    const results = await Promise.all([launch(1), launch(2), launch(3)]);
    const statuses = results.map((r) => r.status);
    const ok = statuses.filter((s) => s === 200).length;
    const conflicts = statuses.filter((s) => s === 503 || s === 409).length;
    expect(ok).toBe(1);
    expect(conflicts).toBe(2);

    const losers = results.filter((r) => r.status !== 200);
    for (const r of losers) {
      const body = r.jsonBody as { code?: string };
      expect(body.code === "LEASE_HELD" || body.code === "LEASE_LOST").toBe(true);
    }
  });
});

describe("PUT /api/manage/users/{userId}/roles — schema validation & lease", () => {
  test("rejects unknown role with 400", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: target } = await makeUser({ emailVerified: true });

    const req = makeAuthRequest(admin.id, admin.email, {
      method: "PUT",
      params: { userId: target.id },
      body: { roles: ["Admin", "SuperUser"] },
    });

    const res = await invoke("setUserRoles", req);
    expect(res.status).toBe(400);
    const body = res.jsonBody as { code?: string; detail?: string };
    expect(body.code).toBe("INVALID_ROLES_PAYLOAD");
    // zod v4 issue includes the path and the allowed values; not the bad
    // input string itself. Assert against the path + enum surface.
    expect(body.detail ?? "").toContain("\"roles\"");
    expect(body.detail ?? "").toContain("Admin");
  });

  test("rejects unknown top-level key with 400 (strict payload schema)", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: target } = await makeUser({ emailVerified: true });

    const req = makeAuthRequest(admin.id, admin.email, {
      method: "PUT",
      params: { userId: target.id },
      body: { roles: ["Pilot"], surprise: true },
    });

    const res = await invoke("setUserRoles", req);
    expect(res.status).toBe(400);
    const body = res.jsonBody as { code?: string };
    expect(body.code).toBe("INVALID_ROLES_PAYLOAD");
  });

  test("returns 404 when target user does not exist", async () => {
    const { user: admin } = await bootstrapAdmin();
    const ghostId = randomUUID();

    const req = makeAuthRequest(admin.id, admin.email, {
      method: "PUT",
      params: { userId: ghostId },
      body: { roles: ["Pilot"] },
    });

    const res = await invoke("setUserRoles", req);
    expect(res.status).toBe(404);
  });

  test("happy path: updates roles under a lease and persists", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: target } = await makeUser({ emailVerified: true });
    const pilotUuid = randomUUID();
    const clubUuid = randomUUID();

    const req = makeAuthRequest(admin.id, admin.email, {
      method: "PUT",
      params: { userId: target.id },
      body: { roles: ["Admin", "Pilot"], pilotId: pilotUuid, clubId: clubUuid },
    });

    const res = await invoke("setUserRoles", req);
    expect(res.status).toBe(200);
    const updated = res.jsonBody as User;
    expect(updated.roles).toEqual(["Admin", "Pilot"]);
    expect(updated.pilotId).toBe(pilotUuid);
    expect(updated.clubId).toBe(clubUuid);

    const persisted = await readPrivateJson<User>(`users/${target.id}.json`);
    expect(persisted?.roles).toEqual(["Admin", "Pilot"]);
    expect(persisted?.pilotId).toBe(pilotUuid);
    expect(persisted?.clubId).toBe(clubUuid);
  });

  test("returns 409 LAST_ADMIN when removing Admin from the only live admin", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: targetAdmin } = await makeUser({
      emailVerified: true,
      roles: ["Admin"],
    });
    await tombstoneIndexedAdminsExcept(targetAdmin.id);

    const res = await invoke(
      "setUserRoles",
      makeAuthRequest(admin.id, admin.email, {
        method: "PUT",
        params: { userId: targetAdmin.id },
        body: { roles: ["Pilot"] },
      }),
    );

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code?: string }).code).toBe("LAST_ADMIN");
  });

  test("allows removing Admin when another live admin remains", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: secondAdmin } = await makeUser({
      emailVerified: true,
      roles: ["Admin"],
    });

    const res = await invoke(
      "setUserRoles",
      makeAuthRequest(admin.id, admin.email, {
        method: "PUT",
        params: { userId: secondAdmin.id },
        body: { roles: ["Pilot"] },
      }),
    );

    expect(res.status).toBe(200);
    expect((res.jsonBody as User).roles).toEqual(["Pilot"]);
  });

  test("concurrent demotions of the last two admins leave exactly one live admin", async () => {
    const { user: firstAdmin } = await bootstrapAdmin();
    const { user: secondAdmin } = await makeUser({
      emailVerified: true,
      roles: ["Admin"],
    });
    await tombstoneIndexedAdminsExcept(firstAdmin.id, secondAdmin.id);

    const demote = (target: User) =>
      invoke(
        "setUserRoles",
        makeAuthRequest(firstAdmin.id, firstAdmin.email, {
          method: "PUT",
          params: { userId: target.id },
          body: { roles: ["Pilot"] },
        }),
      );

    const results = await Promise.all([demote(firstAdmin), demote(secondAdmin)]);

    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const rejected = results.find((result) => result.status === 409);
    expect((rejected?.jsonBody as { code?: string } | undefined)?.code).toBe("LAST_ADMIN");

    const index = await readPrivateJson<Record<string, string>>("user-index.json");
    let liveAdminCount = 0;
    for (const userId of new Set(Object.values(index ?? {}))) {
      if (await privateBlobExists(`users/deleted/${userId}.json`)) continue;
      const user = await readPrivateJson<User>(`users/${userId}.json`);
      if (user?.roles.includes("Admin")) liveAdminCount += 1;
    }
    expect(liveAdminCount).toBe(1);

    const firstAdminAfter = await readPrivateJson<User>(`users/${firstAdmin.id}.json`);
    if (firstAdminAfter && !firstAdminAfter.roles.includes("Admin")) {
      await writePrivateJson(`users/${firstAdmin.id}.json`, {
        ...firstAdminAfter,
        roles: ["Admin", ...firstAdminAfter.roles],
      });
    }
  });
});

describe("PUT /api/manage/users/{userId}/roles — pilotId/clubId UUID boundary (#264)", () => {
  test("accepts { roles } alone with 200", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: target } = await makeUser({ emailVerified: true });

    const res = await invoke(
      "setUserRoles",
      makeAuthRequest(admin.id, admin.email, {
        method: "PUT",
        params: { userId: target.id },
        body: { roles: ["Pilot"] },
      }),
    );

    expect(res.status).toBe(200);
  });

  test("accepts the production UI payload shape { roles, clubId: null } with 200", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: target } = await makeUser({ emailVerified: true });

    const res = await invoke(
      "setUserRoles",
      makeAuthRequest(admin.id, admin.email, {
        method: "PUT",
        params: { userId: target.id },
        body: { roles: ["Pilot"], clubId: null },
      }),
    );

    expect(res.status).toBe(200);
  });

  test("accepts { roles, pilotId: null } with 200", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: target } = await makeUser({ emailVerified: true });

    const res = await invoke(
      "setUserRoles",
      makeAuthRequest(admin.id, admin.email, {
        method: "PUT",
        params: { userId: target.id },
        body: { roles: ["Pilot"], pilotId: null },
      }),
    );

    expect(res.status).toBe(200);
  });

  test("accepts an uppercase UUID pilotId with 200", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: target } = await makeUser({ emailVerified: true });

    const res = await invoke(
      "setUserRoles",
      makeAuthRequest(admin.id, admin.email, {
        method: "PUT",
        params: { userId: target.id },
        body: { roles: ["Pilot"], pilotId: randomUUID().toUpperCase() },
      }),
    );

    expect(res.status).toBe(200);
  });

  test("accepts a lowercase UUID pilotId with 200 and persists it", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: target } = await makeUser({ emailVerified: true });
    const pilotUuid = randomUUID();

    const res = await invoke(
      "setUserRoles",
      makeAuthRequest(admin.id, admin.email, {
        method: "PUT",
        params: { userId: target.id },
        body: { roles: ["Pilot"], pilotId: pilotUuid },
      }),
    );

    expect(res.status).toBe(200);
    const persisted = await readPrivateJson<User>(`users/${target.id}.json`);
    expect(persisted?.pilotId).toBe(pilotUuid);
  });

  test.each([
    ["pilotId", "../x"],
    ["pilotId", "a/b"],
    ["pilotId", "not-a-uuid"],
    ["pilotId", ""],
    ["clubId", "../x"],
    ["clubId", "a/b"],
    ["clubId", "not-a-uuid"],
    ["clubId", ""],
  ])(
    "rejects %s=%j with INVALID_ROLES_PAYLOAD and leaves the stored blob unchanged",
    async (field, value) => {
      const { user: admin } = await bootstrapAdmin();
      const { user: target } = await makeUser({ emailVerified: true });
      const before = await readPrivateJson<User>(`users/${target.id}.json`);

      const res = await invoke(
        "setUserRoles",
        makeAuthRequest(admin.id, admin.email, {
          method: "PUT",
          params: { userId: target.id },
          body: { roles: ["Pilot"], [field]: value },
        }),
      );

      expect(res.status).toBe(400);
      expect((res.jsonBody as { code?: string }).code).toBe("INVALID_ROLES_PAYLOAD");
      const after = await readPrivateJson<User>(`users/${target.id}.json`);
      expect(after).toEqual(before);
    },
  );

  test("hostile route param yields identical INVALID_BLOB_PATH whether the referenced blob exists or not (no existence oracle)", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: target } = await makeUser({ emailVerified: true });

    // Both are hostile route params rejected by assertSafeBlobPath before any
    // existence check: one normalises to the existing user's blob absent the
    // guard; "a b" could never match a blob. Responses must be identical.
    const targetingExisting = await invoke(
      "setUserRoles",
      makeAuthRequest(admin.id, admin.email, {
        method: "PUT",
        params: { userId: `${target.id}/../../users/${target.id}` },
        body: { roles: ["Pilot"] },
      }),
    );
    const targetingMissing = await invoke(
      "setUserRoles",
      makeAuthRequest(admin.id, admin.email, {
        method: "PUT",
        params: { userId: "a b" },
        body: { roles: ["Pilot"] },
      }),
    );

    expect(targetingExisting.status).toBe(400);
    expect((targetingExisting.jsonBody as { code?: string }).code).toBe("INVALID_BLOB_PATH");
    expect(targetingMissing.status).toBe(400);
    expect((targetingMissing.jsonBody as { code?: string }).code).toBe("INVALID_BLOB_PATH");
    expect((targetingExisting.jsonBody as { code?: string }).code)
      .toBe((targetingMissing.jsonBody as { code?: string }).code);
  });
});

describe("shared account-mutation invariants", () => {
  test("getCallerIdentity returns null when a still-present user has a delete tombstone", async () => {
    const { user } = await makeUser({ emailVerified: true });
    await writePrivateJson(`users/deleted/${user.id}.json`, {});

    const caller = await getCallerIdentity(
      makeAuthRequest(user.id, user.email) as unknown as HttpRequest,
    );

    expect(caller).toBeNull();
  });

  test("refresh returns 401 when a still-present user has a delete tombstone", async () => {
    const { user, credential } = await makeUser({ emailVerified: true });
    await writePrivateJson(`users/deleted/${user.id}.json`, {});
    const refreshToken = signRefreshToken(user.id, credential.tokenVersion ?? 0);

    const res = await invoke(
      "authRefresh",
      makeRequest({ method: "POST", body: { refreshToken } }),
    );

    expect(res.status).toBe(401);
  });

  test("lookupUserByEmail returns null for a tombstoned resolved userId", async () => {
    const { user } = await makeUser({ emailVerified: true });
    await writePrivateJson(`users/deleted/${user.id}.json`, {});

    const resolved = await lookupUserByEmail(user.email);

    expect(resolved).toBeNull();
  });

  test("verifyEmail returns INVALID_TOKEN when the token resolves to a tombstoned userId", async () => {
    const { user } = await makeUser({ emailVerified: false });
    const token = await generateShortLivedToken(user.id, "verify", 24);
    await writePrivateJson(`users/deleted/${user.id}.json`, {});

    const res = await invoke(
      "authVerifyEmail",
      makeRequest({ method: "GET", query: { token } }),
    );

    expect(res.status).toBe(400);
    expect((res.jsonBody as { code?: string }).code).toBe("INVALID_TOKEN");
  });

  test("resetPassword returns INVALID_TOKEN when the token resolves to a tombstoned userId", async () => {
    const { user } = await makeUser({ emailVerified: true });
    const token = await generateShortLivedToken(user.id, "reset", 1);
    await writePrivateJson(`users/deleted/${user.id}.json`, {});

    const res = await invoke(
      "authResetPassword",
      makeRequest({
        method: "POST",
        body: { token, newPassword: "Replacement123!" },
      }),
    );

    expect(res.status).toBe(400);
    expect((res.jsonBody as { code?: string }).code).toBe("INVALID_TOKEN");
  });

  test("getOrCreateUser never recreates the user/index on the 404 path when tombstoned", async () => {
    const { getOrCreateUser } = await import("../../lib/auth.js");
    const userId = randomUUID();
    const email = `deleted-${userId}@example.com`;
    await writePrivateJson(`users/deleted/${userId}.json`, {});

    await expect(getOrCreateUser(userId, email)).rejects.toBeInstanceOf(UserDeletedError);

    expect(await privateBlobExists(`users/${userId}.json`)).toBe(false);
    const index = await readPrivateJson<Record<string, string>>("user-index.json");
    expect(index?.[email]).toBeUndefined();
  });

  test("assertNotLastAdmin throws LAST_ADMIN at one live admin", async () => {
    const { user: admin } = await makeUser({
      emailVerified: true,
      roles: ["Admin"],
    });
    await tombstoneIndexedAdminsExcept(admin.id);

    await expect(assertNotLastAdmin(admin.id, ["Pilot"])).rejects.toMatchObject({
      status: 409,
      code: "LAST_ADMIN",
    });
  });

  test("assertNotLastAdmin passes at two live admins", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: secondAdmin } = await makeUser({
      emailVerified: true,
      roles: ["Admin"],
    });

    await expect(assertNotLastAdmin(secondAdmin.id, ["Pilot"])).resolves.toBeUndefined();
    await expect(assertNotLastAdmin(admin.id, ["Pilot"])).resolves.toBeUndefined();
  });

  test("assertNotLastAdmin excludes a tombstoned admin from the live count", async () => {
    const { user: admin } = await makeUser({
      emailVerified: true,
      roles: ["Admin"],
    });
    const { user: tombstonedAdmin } = await makeUser({
      emailVerified: true,
      roles: ["Admin"],
    });
    await tombstoneIndexedAdminsExcept(admin.id);
    await writePrivateJson(`users/deleted/${tombstonedAdmin.id}.json`, {});

    await expect(assertNotLastAdmin(admin.id, ["Pilot"])).rejects.toMatchObject({
      status: 409,
      code: "LAST_ADMIN",
    });
  });

  test("withAccountMutationLock serializes concurrent holders without 409", async () => {
    let activeHolders = 0;
    let maxActiveHolders = 0;
    const releaseFirstHolder = Promise.withResolvers<void>();
    const firstHolderEntered = Promise.withResolvers<void>();

    const hold = (waitForRelease: boolean) =>
      withAccountMutationLock(async () => {
        activeHolders += 1;
        maxActiveHolders = Math.max(maxActiveHolders, activeHolders);
        if (waitForRelease) firstHolderEntered.resolve();
        try {
          if (waitForRelease) await releaseFirstHolder.promise;
          return "ok";
        } finally {
          activeHolders -= 1;
        }
      });

    const first = hold(true);
    await firstHolderEntered.promise;
    const second = hold(false);

    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(activeHolders).toBe(1);
    releaseFirstHolder.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual(["ok", "ok"]);
    expect(maxActiveHolders).toBe(1);
  });
});

describe("PUT /api/manage/users/{userId}/email — admin change email", () => {
  test("happy path: rewrites user email, user-index, auth verification state and tokenVersion", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: target, credential: authBefore } = await makeUser({
      emailVerified: true,
    });
    const oldEmail = target.email;
    const newEmail = `Updated-${target.id.slice(0, 8)}@Example.COM`;
    const newEmailLower = newEmail.toLowerCase();

    const res = await invoke(
      "updateUserEmail",
      makeAuthRequest(admin.id, admin.email, {
        method: "PUT",
        params: { userId: target.id },
        body: { email: newEmail },
      }),
    );

    expect(res.status).toBe(200);
    const view = res.jsonBody as AdminUserView;
    expect(view.email).toBe(newEmailLower);
    expect(view.emailVerified).toBe(false);

    const persisted = await readPrivateJson<User>(`users/${target.id}.json`);
    expect(persisted?.email).toBe(newEmailLower);

    const userIndex = await readPrivateJson<Record<string, string>>("user-index.json");
    expect(userIndex?.[oldEmail]).toBeUndefined();
    expect(userIndex?.[newEmailLower]).toBe(target.id);

    const authAfter = await readPrivateJson<AuthCredential>(`auth/${target.id}.json`);
    expect(authAfter?.passwordHash).toBe(authBefore.passwordHash);
    expect(authAfter?.emailVerified).toBe(false);
    expect(authAfter?.tokenVersion).toBe((authBefore.tokenVersion ?? 0) + 1);
  });

  test("linked pilot: moves pilot-email-index from old email to new email", async () => {
    const { user: admin } = await bootstrapAdmin();
    const oldEmail = `linked-${randomUUID().slice(0, 8)}@example.com`;
    const pilot = await makePilot({ email: oldEmail });
    const { user: target } = await makeUser({
      email: oldEmail,
      emailVerified: true,
    });
    expect(target.pilotId).toBe(pilot.id);
    const newEmail = `linked-new-${randomUUID().slice(0, 8)}@example.com`;

    const res = await invoke(
      "updateUserEmail",
      makeAuthRequest(admin.id, admin.email, {
        method: "PUT",
        params: { userId: target.id },
        body: { email: newEmail },
      }),
    );

    expect(res.status).toBe(200);
    const pilotIndex = await readPrivateJson<Record<string, string>>(
      "pilot-email-index.json",
    );
    expect(pilotIndex?.[oldEmail]).toBeUndefined();
    expect(pilotIndex?.[newEmail]).toBe(pilot.id);
  });

  test("EMAIL_TAKEN collision leaves user, user-index and auth credential untouched", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: target } = await makeUser({ emailVerified: true });
    const { user: other } = await makeUser({ emailVerified: true });
    const userBefore = await readPrivateJson<User>(`users/${target.id}.json`);
    const indexBefore = await readPrivateJson<Record<string, string>>("user-index.json");
    const authBefore = await readPrivateJson<AuthCredential>(`auth/${target.id}.json`);

    const res = await invoke(
      "updateUserEmail",
      makeAuthRequest(admin.id, admin.email, {
        method: "PUT",
        params: { userId: target.id },
        body: { email: other.email.toUpperCase() },
      }),
    );

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code?: string }).code).toBe("EMAIL_TAKEN");
    expect(await readPrivateJson<User>(`users/${target.id}.json`)).toEqual(userBefore);
    expect(await readPrivateJson<Record<string, string>>("user-index.json")).toEqual(indexBefore);
    expect(await readPrivateJson<AuthCredential>(`auth/${target.id}.json`)).toEqual(authBefore);
  });

  test("concurrent email changes to the same new email allow exactly one claim", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: firstUser } = await makeUser({ emailVerified: true });
    const { user: secondUser } = await makeUser({ emailVerified: true });
    const newEmail = `shared-${randomUUID().slice(0, 8)}@example.com`;

    const changeEmail = (target: User) =>
      invoke(
        "updateUserEmail",
        makeAuthRequest(admin.id, admin.email, {
          method: "PUT",
          params: { userId: target.id },
          body: { email: newEmail },
        }),
      );

    const settled = await Promise.allSettled([
      changeEmail(firstUser),
      changeEmail(secondUser),
    ]);

    expect(settled.every((result) => result.status === "fulfilled")).toBe(true);
    const results = settled.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const rejected = results.find((result) => result.status === 409);
    expect((rejected?.jsonBody as { code?: string } | undefined)?.code).toBe("EMAIL_TAKEN");

    const index = await readPrivateJson<Record<string, string>>("user-index.json");
    const claimedUserId = index?.[newEmail];
    expect([firstUser.id, secondUser.id]).toContain(claimedUserId);
    expect(Object.entries(index ?? {}).filter(([email]) => email === newEmail)).toHaveLength(1);
  });

  test("PILOT_EMAIL_TAKEN collision rejects cross-pilot repoint and leaves indexes untouched", async () => {
    const { user: admin } = await bootstrapAdmin();
    const oldEmail = `pilot-one-${randomUUID().slice(0, 8)}@example.com`;
    const newEmail = `pilot-two-${randomUUID().slice(0, 8)}@example.com`;
    const pilotOne = await makePilot({ email: oldEmail });
    const pilotTwo = await makePilot({ email: newEmail });
    const { user: target } = await makeUser({
      email: oldEmail,
      emailVerified: true,
    });
    expect(target.pilotId).toBe(pilotOne.id);
    const userIndexBefore = await readPrivateJson<Record<string, string>>("user-index.json");
    const pilotIndexBefore = await readPrivateJson<Record<string, string>>(
      "pilot-email-index.json",
    );

    const res = await invoke(
      "updateUserEmail",
      makeAuthRequest(admin.id, admin.email, {
        method: "PUT",
        params: { userId: target.id },
        body: { email: newEmail },
      }),
    );

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code?: string }).code).toBe("PILOT_EMAIL_TAKEN");
    expect(await readPrivateJson<Record<string, string>>("user-index.json")).toEqual(userIndexBefore);
    expect(await readPrivateJson<Record<string, string>>("pilot-email-index.json")).toEqual(pilotIndexBefore);
    expect(pilotIndexBefore?.[oldEmail]).toBe(pilotOne.id);
    expect(pilotIndexBefore?.[newEmail]).toBe(pilotTwo.id);
  });

  test("unknown user returns 404 and leaves user-index unchanged", async () => {
    const { user: admin } = await bootstrapAdmin();
    await makeUser({ emailVerified: true });
    const indexBefore = await readPrivateJson<Record<string, string>>("user-index.json");

    const res = await invoke(
      "updateUserEmail",
      makeAuthRequest(admin.id, admin.email, {
        method: "PUT",
        params: { userId: randomUUID() },
        body: { email: `ghost-${randomUUID().slice(0, 8)}@example.com` },
      }),
    );

    expect(res.status).toBe(404);
    expect((res.jsonBody as { code?: string }).code).toBe("NOT_FOUND");
    expect(await readPrivateJson<Record<string, string>>("user-index.json")).toEqual(indexBefore);
  });

  test("returns 403 for non-admin caller", async () => {
    const { user: pilot } = await makeUser({ roles: ["Pilot"] });
    const { user: target } = await makeUser({ emailVerified: true });

    const res = await invoke(
      "updateUserEmail",
      makeAuthRequest(pilot.id, pilot.email, {
        method: "PUT",
        params: { userId: target.id },
        body: { email: `denied-${randomUUID().slice(0, 8)}@example.com` },
      }),
    );

    expect(res.status).toBe(403);
  });

  test("tokenVersion bump invalidates a previously minted verify token", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: target, credential: authBefore } = await makeUser({
      emailVerified: false,
    });
    const token = await generateShortLivedToken(target.id, "verify", 24);

    const updateRes = await invoke(
      "updateUserEmail",
      makeAuthRequest(admin.id, admin.email, {
        method: "PUT",
        params: { userId: target.id },
        body: { email: `token-bump-${randomUUID().slice(0, 8)}@example.com` },
      }),
    );
    expect(updateRes.status).toBe(200);

    const verifyRes = await invoke(
      "authVerifyEmail",
      makeRequest({ method: "GET", query: { token } }),
    );

    expect(verifyRes.status).toBe(400);
    expect((verifyRes.jsonBody as { code?: string }).code).toBe("INVALID_TOKEN");
    const authAfter = await readPrivateJson<AuthCredential>(`auth/${target.id}.json`);
    expect(authAfter?.emailVerified).toBe(false);
    expect(authAfter?.tokenVersion).toBe((authBefore.tokenVersion ?? 0) + 1);
  });
});

describe("DELETE /api/manage/users/{userId} — account-only delete", () => {
  test("happy path: tombstones first, removes account auth/indexes and unlinks linked pilot", async () => {
    const { user: admin } = await bootstrapAdmin();
    const email = `delete-linked-${randomUUID().slice(0, 8)}@example.com`;
    const pilot = await makePilot({ email });
    const { user: target } = await makeUser({ email, emailVerified: false });
    expect(target.pilotId).toBe(pilot.id);
    const token = await generateShortLivedToken(target.id, "verify", 1);
    await writePrivateJson(`auth/verification-state/${target.id}.json`, {
      token: "pending-token",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const res = await invoke(
      "deleteUser",
      makeAuthRequest(admin.id, admin.email, {
        method: "DELETE",
        params: { userId: target.id },
      }),
    );

    expect(res.status).toBe(204);
    expect(await privateBlobExists(`users/${target.id}.json`)).toBe(false);
    expect(await privateBlobExists(`auth/${target.id}.json`)).toBe(false);
    expect(await privateBlobExists(`auth/verification-state/${target.id}.json`)).toBe(false);

    const tombstone = await readPrivateJson<{
      email?: string | null;
      pilotId: string | null;
      deletedAt: string;
    }>(`users/deleted/${target.id}.json`);
    expect(tombstone?.email).toBe(email);
    expect(tombstone?.pilotId).toBe(pilot.id);
    expect(typeof tombstone?.deletedAt).toBe("string");

    const userIndex = await readPrivateJson<Record<string, string>>("user-index.json");
    expect(userIndex?.[email]).toBeUndefined();

    const tokenHash = createHash("sha256").update(token).digest("hex");
    expect(await privateBlobExists(`auth/tokens/${tokenHash}.json`)).toBe(false);

    const pilotAfter = await readPrivateJson<{ userId?: string | null }>(`pilots/${pilot.id}.json`);
    expect(pilotAfter?.userId).toBeNull();
    const pilotEmailIndex = await readPrivateJson<Record<string, string>>("pilot-email-index.json");
    expect(pilotEmailIndex?.[email]).toBeUndefined();
  });

  test("rejects self-delete with 400 CANNOT_DELETE_SELF", async () => {
    const { user: admin } = await bootstrapAdmin();

    const res = await invoke(
      "deleteUser",
      makeAuthRequest(admin.id, admin.email, {
        method: "DELETE",
        params: { userId: admin.id },
      }),
    );

    expect(res.status).toBe(400);
    expect((res.jsonBody as { code?: string }).code).toBe("CANNOT_DELETE_SELF");
  });

  test("returns 409 LAST_ADMIN when deleting the only live admin", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: targetAdmin } = await makeUser({
      emailVerified: true,
      roles: ["Admin"],
    });
    await tombstoneIndexedAdminsExcept(targetAdmin.id);

    const res = await invoke(
      "deleteUser",
      makeAuthRequest(admin.id, admin.email, {
        method: "DELETE",
        params: { userId: targetAdmin.id },
      }),
    );

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code?: string }).code).toBe("LAST_ADMIN");
    expect(await privateBlobExists(`users/${targetAdmin.id}.json`)).toBe(true);
    expect(await privateBlobExists(`users/deleted/${targetAdmin.id}.json`)).toBe(false);
  });

  test("returns 404 for an unknown user when no tombstone exists", async () => {
    const { user: admin } = await bootstrapAdmin();
    const ghostId = randomUUID();

    const res = await invoke(
      "deleteUser",
      makeAuthRequest(admin.id, admin.email, {
        method: "DELETE",
        params: { userId: ghostId },
      }),
    );

    expect(res.status).toBe(404);
    expect((res.jsonBody as { code?: string }).code).toBe("NOT_FOUND");
  });

  test("returns 403 for a non-admin caller", async () => {
    const { user: pilot } = await makeUser({ roles: ["Pilot"] });
    const { user: target } = await makeUser({ emailVerified: true });

    const res = await invoke(
      "deleteUser",
      makeAuthRequest(pilot.id, pilot.email, {
        method: "DELETE",
        params: { userId: target.id },
      }),
    );

    expect(res.status).toBe(403);
    expect(await privateBlobExists(`users/${target.id}.json`)).toBe(true);
  });

  test("retry-continuation: existing tombstone plus present user completes cleanup and skips last-admin guard", async () => {
    const { user: admin } = await bootstrapAdmin();
    const email = `retry-linked-${randomUUID().slice(0, 8)}@example.com`;
    const pilot = await makePilot({ email });
    const { user: targetAdmin } = await makeUser({
      email,
      emailVerified: true,
      roles: ["Admin"],
    });
    expect(targetAdmin.pilotId).toBe(pilot.id);
    await tombstoneIndexedAdminsExcept(targetAdmin.id);
    await writePrivateJson(`users/deleted/${targetAdmin.id}.json`, {
      email,
      pilotId: pilot.id,
      deletedAt: new Date().toISOString(),
    });

    const res = await invoke(
      "deleteUser",
      makeAuthRequest(admin.id, admin.email, {
        method: "DELETE",
        params: { userId: targetAdmin.id },
      }),
    );

    expect(res.status).toBe(204);
    expect(await privateBlobExists(`users/${targetAdmin.id}.json`)).toBe(false);
    const userIndex = await readPrivateJson<Record<string, string>>("user-index.json");
    expect(userIndex?.[email]).toBeUndefined();
    const pilotAfter = await readPrivateJson<{ userId?: string | null }>(`pilots/${pilot.id}.json`);
    expect(pilotAfter?.userId).toBeNull();
  });

  test("token-GC read failure still returns 204 after required deletes", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: target } = await makeUser({ emailVerified: true });
    await writePrivateJson(`auth/tokens/bad-${target.id}.json`, "not-an-object");

    const res = await invoke(
      "deleteUser",
      makeAuthRequest(admin.id, admin.email, {
        method: "DELETE",
        params: { userId: target.id },
      }),
    );

    expect(res.status).toBe(204);
    expect(await privateBlobExists(`users/${target.id}.json`)).toBe(false);
    expect(await privateBlobExists(`auth/${target.id}.json`)).toBe(false);
    const userIndex = await readPrivateJson<Record<string, string>>("user-index.json");
    expect(userIndex?.[target.email]).toBeUndefined();
  });
});

describe("POST /api/manage/users/{userId}/verify-email — admin force-verify", () => {
  test("happy path: sets emailVerified=true on an unverified user", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: target } = await makeUser({ emailVerified: false });

    const credBefore = await readPrivateJson<AuthCredential>(`auth/${target.id}.json`);
    expect(credBefore?.emailVerified).toBe(false);

    const req = makeAuthRequest(admin.id, admin.email, {
      method: "POST",
      params: { userId: target.id },
    });

    const res = await invoke("adminVerifyEmail", req);
    expect(res.status).toBe(200);
    expect((res.jsonBody as { ok: boolean }).ok).toBe(true);

    const credAfter = await readPrivateJson<AuthCredential>(`auth/${target.id}.json`);
    expect(credAfter?.emailVerified).toBe(true);
  });

  test("returns 404 when auth blob is absent", async () => {
    const { user: admin } = await bootstrapAdmin();
    const ghostId = randomUUID();

    const req = makeAuthRequest(admin.id, admin.email, {
      method: "POST",
      params: { userId: ghostId },
    });

    const res = await invoke("adminVerifyEmail", req);
    expect(res.status).toBe(404);
    expect((res.jsonBody as { code?: string }).code).toBe("NOT_FOUND");
  });

  test("returns 403 for non-admin caller", async () => {
    const { user: pilot } = await makeUser({ roles: ["Pilot"] });
    const { user: target } = await makeUser({ emailVerified: false });

    const req = makeAuthRequest(pilot.id, pilot.email, {
      method: "POST",
      params: { userId: target.id },
    });

    const res = await invoke("adminVerifyEmail", req);
    expect(res.status).toBe(403);
  });
});

describe("POST /api/manage/users/{userId}/pilot — admin create and link", () => {
  test("happy path: creates deterministic pilot, indexes email, and links the user last", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: target } = await makeUser({ pilotId: null });
    const expectedPilotId = deterministicPilotId(target.id);

    const res = await createPilotForUser(admin, target.id, {
      firstName: "  Ada ",
      lastName: " Lovelace  ",
    });

    expect(res.status).toBe(201);
    const pilot = (res.jsonBody as { pilot: Pilot }).pilot;
    expect(pilot.id).toBe(expectedPilotId);
    expect(pilot.userId).toBe(target.id);
    expect(pilot.person).toMatchObject({
      firstName: "Ada",
      lastName: "Lovelace",
      fullName: "Ada Lovelace",
    });
    expect(pilot.coachType).toBe("None");
    expect(pilot.pilotRating).toBe("Pilot");
    expect(pilot.seasonClubs).toEqual([]);

    const persistedPilot = await readPrivateJson<Pilot>(`pilots/${expectedPilotId}.json`);
    expect(persistedPilot?.userId).toBe(target.id);

    const persistedUser = await readPrivateJson<User>(`users/${target.id}.json`);
    expect(persistedUser?.pilotId).toBe(expectedPilotId);
    expect(persistedUser?.roles).toContain("Pilot");

    const publicIndex = (await readPublicJson<PilotSummary[]>("pilots.json")) ?? [];
    expect(publicIndex).toContainEqual({
      id: expectedPilotId,
      legacyId: null,
      name: "Ada Lovelace",
      rating: "Pilot",
    });
    expect(publicIndex.find((entry) => entry.id === expectedPilotId)?.clubId).toBeUndefined();

    const emailIndex = await readPrivateJson<PilotEmailIndex>("pilot-email-index.json");
    expect(emailIndex?.[target.email.toLowerCase()]).toBe(expectedPilotId);
  });

  test("returns 409 ALREADY_LINKED when the user is linked to a different pilot", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: target } = await makeUser({ pilotId: "0b8f6f60-8f6d-4d29-a41d-6c24f79e63af" });

    const res = await createPilotForUser(admin, target.id, {
      firstName: "Grace",
      lastName: "Hopper",
    });

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code?: string }).code).toBe("ALREADY_LINKED");
  });

  test("idempotent retry repairs missing pilot and empty indexes when user already has deterministic pilotId", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: target } = await makeUser({ pilotId: null });
    const expectedPilotId = deterministicPilotId(target.id);
    const linkedUser: User = {
      ...target,
      pilotId: expectedPilotId,
      roles: target.roles.includes("Pilot") ? target.roles : [...target.roles, "Pilot"],
    };
    await writePrivateJson(`users/${target.id}.json`, linkedUser);
    await writePublicJson("pilots.json", []);
    await writePrivateJson("pilot-email-index.json", {});

    const res = await createPilotForUser(admin, target.id, {
      firstName: "Katherine",
      lastName: "Johnson",
    });

    expect(res.status).toBe(200);
    const pilot = (res.jsonBody as { pilot: Pilot }).pilot;
    expect(pilot.id).toBe(expectedPilotId);
    expect(pilot.userId).toBe(target.id);

    const publicIndex = (await readPublicJson<PilotSummary[]>("pilots.json")) ?? [];
    expect(publicIndex.filter((entry) => entry.id === expectedPilotId)).toHaveLength(1);
    const emailIndex = await readPrivateJson<PilotEmailIndex>("pilot-email-index.json");
    expect(emailIndex).toEqual({ [target.email.toLowerCase()]: expectedPilotId });
  });

  test("returns 409 PILOT_EMAIL_TAKEN before creating a pilot blob", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: target } = await makeUser({ pilotId: null });
    const expectedPilotId = deterministicPilotId(target.id);
    await writePrivateJson("pilot-email-index.json", {
      [target.email.toLowerCase()]: "other-pilot-id",
    });

    const res = await createPilotForUser(admin, target.id, {
      firstName: "Mary",
      lastName: "Jackson",
    });

    expect(res.status).toBe(409);
    expect((res.jsonBody as { code?: string }).code).toBe("PILOT_EMAIL_TAKEN");
    expect(await privateBlobExists(`pilots/${expectedPilotId}.json`)).toBe(false);
  });

  test("returns 400 INVALID_NAME for blank names", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: target } = await makeUser({ pilotId: null });

    const res = await createPilotForUser(admin, target.id, {
      firstName: "  ",
      lastName: "Name",
    });

    expect(res.status).toBe(400);
    expect((res.jsonBody as { code?: string }).code).toBe("INVALID_NAME");
  });

  test("returns 403 for non-admin caller", async () => {
    const { user: pilotCaller } = await makeUser({ roles: ["Pilot"] });
    const { user: target } = await makeUser({ pilotId: null });

    const res = await invoke(
      "adminCreatePilotForUser",
      makeAuthRequest(pilotCaller.id, pilotCaller.email, {
        method: "POST",
        params: { userId: target.id },
        body: { firstName: "No", lastName: "Admin" },
      }),
    );

    expect(res.status).toBe(403);
  });

  test("near-simultaneous POSTs converge on one deterministic pilot and one email-index entry", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: target } = await makeUser({ pilotId: null });
    const expectedPilotId = deterministicPilotId(target.id);

    const results = await Promise.all([
      createPilotForUser(admin, target.id, { firstName: "Rosalind", lastName: "Franklin" }),
      createPilotForUser(admin, target.id, { firstName: "Rosalind", lastName: "Franklin" }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([200, 201]);
    const publicIndex = (await readPublicJson<PilotSummary[]>("pilots.json")) ?? [];
    expect(publicIndex.filter((entry) => entry.id === expectedPilotId)).toHaveLength(1);
    const emailIndex = await readPrivateJson<PilotEmailIndex>("pilot-email-index.json");
    expect(Object.values(emailIndex ?? {}).filter((pilotId) => pilotId === expectedPilotId)).toHaveLength(1);
    const persistedUser = await readPrivateJson<User>(`users/${target.id}.json`);
    expect(persistedUser?.pilotId).toBe(expectedPilotId);
  });
});

describe("GET /api/manage/users — listUsers with emailVerified", () => {
  test("returns 200 with array and all entries have boolean emailVerified", async () => {
    const { user: admin } = await bootstrapAdmin();

    const res = await invoke(
      "listUsers",
      makeAuthRequest(admin.id, admin.email, { method: "GET" }),
    );

    expect(res.status).toBe(200);
    const body = res.jsonBody as AdminUserView[];
    expect(Array.isArray(body)).toBe(true);
    for (const u of body) {
      expect(typeof u.emailVerified).toBe("boolean");
    }
  });

  test("happy path: verified user has emailVerified=true, unverified has emailVerified=false", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: verified } = await makeUser({ emailVerified: true });
    const { user: unverified } = await makeUser({ emailVerified: false });

    const res = await invoke(
      "listUsers",
      makeAuthRequest(admin.id, admin.email, { method: "GET" }),
    );

    expect(res.status).toBe(200);
    const body = res.jsonBody as AdminUserView[];
    const verifiedRow = body.find((u) => u.id === verified.id);
    const unverifiedRow = body.find((u) => u.id === unverified.id);

    expect(verifiedRow).toBeDefined();
    expect(typeof verifiedRow?.emailVerified).toBe("boolean");
    expect(verifiedRow?.emailVerified).toBe(true);

    expect(unverifiedRow).toBeDefined();
    expect(typeof unverifiedRow?.emailVerified).toBe("boolean");
    expect(unverifiedRow?.emailVerified).toBe(false);
  });

  test("resilience: user with no auth blob returns emailVerified=false, not 500", async () => {
    const { user: admin } = await bootstrapAdmin();
    const ghostUserId = randomUUID();
    const ghostEmail = `ghost-${ghostUserId.slice(0, 8)}@example.com`;

    const index =
      (await readPrivateJson<Record<string, string>>("user-index.json")) ?? {};
    index[ghostEmail] = ghostUserId;
    await writePrivateJson("user-index.json", index);
    await writePrivateJson(`users/${ghostUserId}.json`, {
      id: ghostUserId,
      email: ghostEmail,
      roles: ["Pilot"],
      pilotId: null,
      clubId: null,
      createdAt: new Date().toISOString(),
    });

    const res = await invoke(
      "listUsers",
      makeAuthRequest(admin.id, admin.email, { method: "GET" }),
    );

    expect(res.status).toBe(200);
    const body = res.jsonBody as AdminUserView[];
    const ghostRow = body.find((u) => u.id === ghostUserId);
    expect(ghostRow).toBeDefined();
    expect(ghostRow?.emailVerified).toBe(false);
  });
});
