// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * Admin endpoints — Phase 3 + Phase 5
 *
 * POST /api/admin/rounds/{id}/recompute — recompute all derived blobs for a round's season
 * GET  /api/admin/config                — get config document
 * PUT  /api/admin/config                — update config document
 * GET  /api/admin/users                 — list all users + roles (Phase 5)
 * PUT  /api/admin/users/{userId}/roles  — set user roles (Phase 5)
 */

import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { createHash, randomUUID } from "node:crypto";
import type { ContainerClient } from "@azure/storage-blob";
import type { AdminUserView, Config, Pilot, PilotEmailIndex, PilotSummary, Round, User } from "@bccweb/types";
import { AuthCredentialSchema, ConfigPatchSchema, ConfigSchema, PilotSchema, PilotSummarySchema, RoundSchema, UserSchema, UuidIdSchema } from "@bccweb/schemas";
import * as z from "zod/v4";
import {
  ensureJsonIndexBlob,
  ensurePrivateJsonIndexBlob,
  getBlobClient,
  getPrivateBlobClient,
  withLeaseRetry,
  withPrivateLease,
  withPrivateLeaseRetry,
  writeBlob,
} from "../lib/blob.js";
import { readJson, writePrivateJson } from "../lib/blobJson.js";
import {
  getCallerIdentity,
  unauthorizedResponse,
  forbiddenResponse,
} from "../lib/auth.js";
import { createVerificationToken, sendVerificationEmail } from "../lib/authHelpers.js";
import { assertNotLastAdmin, withAccountMutationLock } from "../lib/accountMutation.js";
import { HttpError, withErrorHandler } from "../lib/http.js";
import { mutationRateLimit } from "../lib/rateLimit.js";
import { recomputeSeason, updateRoundsIndex } from "../lib/recompute.js";
import { getBlobServiceClient } from "../lib/storageClients.js";

// ─── Auth helper ──────────────────────────────────────────────────────────────

function isAdmin(roles: string[]): boolean {
  return roles.includes("Admin");
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function statusCodeOf(err: unknown): number | undefined {
  return (err as { statusCode?: number }).statusCode;
}

const StringRecordSchema = z.record(z.string(), z.string());
const PilotsIndexSchema = z.array(PilotSummarySchema);

const AdminCreatePilotBodySchema = z
  .object({
    firstName: z.string(),
    lastName: z.string(),
  });

const EmailPayloadSchema = z.strictObject({
  email: z.string(),
});

const AuthTokenUserSchema = z.looseObject({
  userId: z.string(),
});

const DeletedUserTombstoneSchema = z.strictObject({
  email: z.string().nullable().optional(),
  pilotId: z.string().nullable(),
  deletedAt: z.string(),
});

type DeletedUserTombstone = z.infer<typeof DeletedUserTombstoneSchema>;

function getPrivateContainer(): ContainerClient {
  const containerName = process.env["BLOB_PRIVATE_CONTAINER_NAME"];
  if (!containerName) {
    throw new Error("BLOB_PRIVATE_CONTAINER_NAME environment variable is not set");
  }
  return getBlobServiceClient().getContainerClient(containerName);
}

/**
 * Convert Azure blob-lease conflict (HTTP 409 LeaseAlreadyPresent) into a
 * 503 surfaced through `withErrorHandler`. Concurrent writers retry-later.
 */
function rethrowLeaseConflict(err: unknown): never {
  const status = statusCodeOf(err);
  if (status === 409) {
    throw new HttpError(503, "LEASE_HELD", "Resource locked; retry shortly");
  }
  if (status === 412) {
    // Mid-flight lease lost or precondition failure.
    throw new HttpError(503, "LEASE_LOST", "Resource lease lost; retry shortly");
  }
  throw err;
}

/**
 * Ensure-create a private blob (no overwrite) using `ifNoneMatch: "*"`.
 * Mirrors the `ensurePilotsIndexBlob` pattern at pilots.ts:374-390 but for
 * `data-private` and routed through writePrivateJson so BLOB_SCHEMA_MODE is
 * honoured.
 */
async function ensurePrivateBlob<T>(
  path: string,
  schema: z.ZodType<T>,
  defaults: T,
): Promise<void> {
  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await writePrivateJson(path, schema, defaults, undefined, {
        ifNoneMatch: "*",
      });
      return;
    } catch (err: unknown) {
      const status = statusCodeOf(err);
      // 409 = blob already exists; nothing to do.
      if (status === 409) return;
      // 412 = ifNoneMatch failed (also "already exists"); nothing to do.
      if (status === 412) return;
      if (attempt === maxAttempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
}

// ─── POST /api/admin/rounds/{id}/recompute ────────────────────────────────────
/**
 * Recompute all derived blobs for the season containing round {id}.
 * Also refreshes the round's entry in rounds.json.
 * Use this to recover from partial failures during completeRound.
 */
async function recomputeRound(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isAdmin(caller.roles)) return forbiddenResponse();
  await mutationRateLimit(req, caller, "recomputeRound", "standard");

  const id = req.params["id"];
  if (!id) throw new HttpError(400, "MISSING_ROUND_ID", "Missing round id");

  let round: Round;
  try {
    round = await readJson(
      getPrivateBlobClient(`rounds/${id}.json`),
      RoundSchema,
      `rounds/${id}.json`,
    );
  } catch (err: unknown) {
    if (statusCodeOf(err) === 404) {
      throw new HttpError(404, "NOT_FOUND", "Round not found");
    }
    throw new HttpError(500, "INTERNAL");
  }

  // Refresh the round's index entry
  await updateRoundsIndex(round);

  // Recompute season derived blobs
  try {
    await recomputeSeason(round.season.year);
  } catch (_err: unknown) {
    throw new HttpError(500, "RECOMPUTE_FAILED");
  }

  return {
    status: 200,
    jsonBody: { message: `Recomputed season ${round.season.year}` },
  };
}

// ─── GET /api/admin/config ────────────────────────────────────────────────────

async function getConfig(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isAdmin(caller.roles)) return forbiddenResponse();

  try {
    const config = await readJson(
      getPrivateBlobClient("config.json"),
      ConfigSchema,
      "config.json",
    );
    return { status: 200, jsonBody: config };
  } catch (err: unknown) {
    if (statusCodeOf(err) !== 404) throw err;
  }

  // Virgin store: parse {} → ConfigSchema yields full defaults; persist for
  // next reader. ensure-create (ifNoneMatch:"*") tolerates concurrent virgin
  // creates.
  const defaults = ConfigSchema.parse({});
  await ensurePrivateBlob("config.json", ConfigSchema, defaults);
  return { status: 200, jsonBody: defaults };
}

// ─── PUT /api/admin/config ────────────────────────────────────────────────────

// NOT `Partial<Config>`: nested factor maps here have OPTIONAL keys, so an admin
// may PATCH one sub-map key without resending the siblings.
type ConfigPatch = z.infer<typeof ConfigPatchSchema>;

async function updateConfig(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isAdmin(caller.roles)) return forbiddenResponse();
  await mutationRateLimit(req, caller, "updateConfig", "standard");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON");
  }

  // Client-input validation: reject obviously bad shapes with 400 (don't
  // route through BlobShapeError → 500, which is reserved for storage shape
  // drift). ConfigPatchSchema keeps each nested factor map `.strict()` (unknown
  // wing/pilot/factor keys → 400) but carries NO defaults, so a partial body is
  // never hydrated — omitted siblings stay omitted for the deep-merge below.
  const parsed = ConfigPatchSchema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(
      400,
      "INVALID_CONFIG",
      `Invalid config: ${JSON.stringify(parsed.error.issues)}`,
    );
  }
  const patch: ConfigPatch = parsed.data;

  let merged: Config = ConfigSchema.parse({});
  try {
    await runConfigRmw(patch, (m) => { merged = m; });
  } catch (err: unknown) {
    if (statusCodeOf(err) === 404) {
      // Virgin store: seed defaults so the lease has a blob to attach to,
      // then retry the RMW once. ensure-create tolerates concurrent virgins.
      const defaults = ConfigSchema.parse({});
      await ensurePrivateBlob("config.json", ConfigSchema, defaults);
      try {
        await runConfigRmw(patch, (m) => { merged = m; });
      } catch (retryErr: unknown) {
        rethrowLeaseConflict(retryErr);
      }
    } else {
      rethrowLeaseConflict(err);
    }
  }

  return { status: 200, jsonBody: merged };
}

async function runConfigRmw(
  patch: ConfigPatch,
  onMerged: (merged: Config) => void,
): Promise<void> {
  await withPrivateLease("config.json", async (leaseId) => {
    const existing = await readJson(
      getPrivateBlobClient("config.json"),
      ConfigSchema,
      "config.json",
    );
    // Deep-merge: each nested factor map merges key-by-key so a partial
    // sub-map edit keeps untouched siblings (`patch` has no defaults to
    // hydrate them). The map spreads MUST run after `...patch`, which would
    // otherwise splice in the partial maps wholesale.
    const mergedCandidate = {
      ...existing,
      ...patch,
      wingFactors: { ...existing.wingFactors, ...(patch.wingFactors ?? {}) },
      pilotFactors: { ...existing.pilotFactors, ...(patch.pilotFactors ?? {}) },
      clubsAttendingFactors: {
        ...existing.clubsAttendingFactors,
        ...(patch.clubsAttendingFactors ?? {}),
      },
      minDistanceFactors: {
        ...existing.minDistanceFactors,
        ...(patch.minDistanceFactors ?? {}),
      },
    };
    // `existing` is already complete, so this only re-affirms the stored blob
    // is a valid full Config.
    const merged: Config = ConfigSchema.parse(mergedCandidate);
    await writePrivateJson("config.json", ConfigSchema, merged, leaseId);
    onMerged(merged);
  });
}

// ─── GET /api/admin/users ─────────────────────────────────────────────────────

async function listUsers(
  req: HttpRequest,
  ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isAdmin(caller.roles)) return forbiddenResponse();

  let index: Record<string, string> = {};
  try {
    index = await readJson(
      getPrivateBlobClient("user-index.json"),
      z.record(z.string(), z.string()),
      "user-index.json",
    );
  } catch {
    return { status: 200, jsonBody: [] as AdminUserView[] };
  }

  const userIds = Object.values(index);
  const users = await Promise.all(
    userIds.map((id) =>
      readJson(
        getPrivateBlobClient(`users/${id}.json`),
        UserSchema,
        `users/${id}.json`,
      ).catch(() => null)
    )
  );

  const valid = users.flatMap((u) => (u === null ? [] : [u]));
  valid.sort((a, b) => a.email.localeCompare(b.email));

  const views: AdminUserView[] = await Promise.all(
    valid.map(async (user): Promise<AdminUserView> => {
      let emailVerified = false;
      try {
        const cred = await readJson(
          getPrivateBlobClient(`auth/${user.id}.json`),
          AuthCredentialSchema,
          `auth/${user.id}.json`,
        );
        emailVerified = cred.emailVerified;
      } catch (err: unknown) {
        const code = statusCodeOf(err);
        if (code !== 404) {
          ctx.error(
            `[listUsers] failed to read auth/${user.id}.json (status=${code ?? "unknown"}): ${String(err)}`,
          );
        }
      }
      return { ...user, emailVerified };
    })
  );

  return { status: 200, jsonBody: views };
}

// ─── PUT /api/admin/users/{userId}/roles ─────────────────────────────────────

// Client-input role validation (inline). UserSchema's `roles` field uses
// preprocess+normalisation for stored-blob healing; this stricter schema
// rejects unknown roles outright on the API edge, and constrains pilotId/clubId
// to UUID format (null/omitted stay allowed) so admin-set IDs can never carry
// path-traversal segments into blob paths.
const RolesPayloadSchema = z.strictObject({
  roles: z.array(z.enum(["Admin", "RoundsCoord", "Pilot"])).optional(),
  pilotId: UuidIdSchema.nullable().optional(),
  clubId: UuidIdSchema.nullable().optional(),
});

async function setUserRoles(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isAdmin(caller.roles)) return forbiddenResponse();
  await mutationRateLimit(req, caller, "setUserRoles", "standard");

  const userId = req.params["userId"];
  if (!userId) throw new HttpError(400, "MISSING_USER_ID", "Missing userId");

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON");
  }

  const parsed = RolesPayloadSchema.safeParse(rawBody);
  if (!parsed.success) {
    throw new HttpError(
      400,
      "INVALID_ROLES_PAYLOAD",
      `Invalid roles payload: ${JSON.stringify(parsed.error.issues)}`,
    );
  }
  const body = parsed.data;

  let updated: User | null = null;
  try {
    await withAccountMutationLock(async () => {
      await withPrivateLease(`users/${userId}.json`, async (leaseId) => {
        let user: User;
        try {
          user = await readJson(
            getPrivateBlobClient(`users/${userId}.json`),
            UserSchema,
            `users/${userId}.json`,
          );
        } catch (err: unknown) {
          if (statusCodeOf(err) === 404) {
            throw new HttpError(404, "NOT_FOUND", "User not found");
          }
          throw err;
        }

        if (
          body.roles !== undefined &&
          user.roles.includes("Admin") &&
          !body.roles.includes("Admin")
        ) {
          await assertNotLastAdmin(userId, body.roles);
        }

        updated = {
          ...user,
          ...(body.roles !== undefined && { roles: body.roles }),
          ...(body.pilotId !== undefined && { pilotId: body.pilotId }),
          ...(body.clubId !== undefined && { clubId: body.clubId }),
        };

        await writePrivateJson(
          `users/${userId}.json`,
          UserSchema,
          updated,
          leaseId,
        );
      });
    });
  } catch (err: unknown) {
    if (err instanceof HttpError) throw err;
    // Lease acquire on a non-existent blob 404s; surface that as NOT_FOUND.
    if (statusCodeOf(err) === 404) {
      throw new HttpError(404, "NOT_FOUND", "User not found");
    }
    rethrowLeaseConflict(err);
  }

  // Unreachable on success: withPrivateLease always populates `updated`.
  if (!updated) throw new HttpError(500, "INTERNAL");
  return { status: 200, jsonBody: updated };
}

// ─── PUT /api/manage/users/{userId}/email ────────────────────────────────────

async function updateUserEmail(
  req: HttpRequest,
  ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isAdmin(caller.roles)) return forbiddenResponse();
  await mutationRateLimit(req, caller, "updateUserEmail", "standard");

  const userId = req.params["userId"];
  if (!userId) throw new HttpError(400, "MISSING_USER_ID", "Missing userId");

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON");
  }

  const parsed = EmailPayloadSchema.safeParse(rawBody);
  if (!parsed.success || !EMAIL_REGEX.test(parsed.data.email)) {
    throw new HttpError(400, "INVALID_EMAIL", "Invalid email address");
  }
  const newEmail = parsed.data.email.toLowerCase();

  let updated: AdminUserView | null = null;
  let verifyTokenToSend: string | null = null;
  try {
    const result = await withAccountMutationLock(async () => {
      const userPath = `users/${userId}.json`;
      const user = await readUserLocked(userPath);
      const oldEmail = user.email.toLowerCase();
      const pilotId = user.pilotId;

      const userIndex = await readStringIndexLocked("user-index.json");
      const existingUserId = userIndex[newEmail];
      if (existingUserId && existingUserId !== userId) {
        throw new HttpError(409, "EMAIL_TAKEN", "Email already belongs to another user");
      }

      if (pilotId) {
        const pilotEmailIndex = await readStringIndexLocked("pilot-email-index.json");
        const existingPilotId = pilotEmailIndex[newEmail];
        if (existingPilotId && existingPilotId !== pilotId) {
          throw new HttpError(409, "PILOT_EMAIL_TAKEN", "Email already belongs to another pilot");
        }
      }

      await writeUserIndexEmail(oldEmail, newEmail, userId);
      await markAuthEmailUnverified(userId);

      if (pilotId) {
        await writePilotEmailIndex(oldEmail, newEmail, pilotId);
      }

      const updatedUser: User = { ...user, email: newEmail, sessionVersion: (user.sessionVersion ?? 0) + 1 };
      await withPrivateLeaseRetry(userPath, async (leaseId) => {
        await writePrivateJson(userPath, UserSchema, updatedUser, leaseId);
      });

      await bestEffortDeleteAuthArtifacts(userId, ctx, "updateUserEmail");

      // Mint the re-verification token AFTER the GC sweep and AFTER
      // markAuthEmailUnverified so it survives the sweep and carries the
      // post-bump cred.tokenVersion; minted earlier, authVerifyEmail rejects it
      // (deleted token / version mismatch → 400) and locks the user out.
      const verify = await createVerificationToken(userId, 24);
      return { view: { ...updatedUser, emailVerified: false }, token: verify.token };
    });
    updated = result.view;
    verifyTokenToSend = result.token;
  } catch (err: unknown) {
    if (err instanceof HttpError) throw err;
    if (statusCodeOf(err) === 404) {
      throw new HttpError(404, "NOT_FOUND", "User not found");
    }
    rethrowLeaseConflict(err);
  }

  // Email the link OUTSIDE the mutation lock — the ACS/network call must not hold
  // the account lease. Best-effort: sendVerificationEmail swallows send errors.
  if (updated && verifyTokenToSend) {
    await sendVerificationEmail(newEmail, verifyTokenToSend);
  }

  return { status: 200, jsonBody: updated };
}

async function readUserLocked(userPath: string): Promise<User> {
  try {
    return await withPrivateLeaseRetry(userPath, () =>
      readJson(getPrivateBlobClient(userPath), UserSchema, userPath)
    );
  } catch (err: unknown) {
    if (statusCodeOf(err) === 404) {
      throw new HttpError(404, "NOT_FOUND", "User not found");
    }
    throw err;
  }
}

async function readStringIndexLocked(path: string): Promise<Record<string, string>> {
  try {
    return await withPrivateLeaseRetry(path, () =>
      readJson(getPrivateBlobClient(path), StringRecordSchema, path)
    );
  } catch (err: unknown) {
    if (statusCodeOf(err) === 404) return {};
    throw err;
  }
}

async function writeUserIndexEmail(
  oldEmail: string,
  newEmail: string,
  userId: string,
): Promise<void> {
  await ensurePrivateBlob("user-index.json", StringRecordSchema, {});
  await withPrivateLeaseRetry("user-index.json", async (leaseId) => {
    const index = await readJson(
      getPrivateBlobClient("user-index.json"),
      StringRecordSchema,
      "user-index.json",
    );
    if (index[newEmail] && index[newEmail] !== userId) {
      throw new HttpError(409, "EMAIL_TAKEN", "Email already belongs to another user");
    }
    delete index[oldEmail];
    index[newEmail] = userId;
    await writePrivateJson("user-index.json", StringRecordSchema, index, leaseId);
  });
}

async function writePilotEmailIndex(
  oldEmail: string,
  newEmail: string,
  pilotId: string,
): Promise<void> {
  await ensurePrivateBlob("pilot-email-index.json", StringRecordSchema, {});
  await withPrivateLeaseRetry("pilot-email-index.json", async (leaseId) => {
    const index = await readJson(
      getPrivateBlobClient("pilot-email-index.json"),
      StringRecordSchema,
      "pilot-email-index.json",
    );
    if (index[newEmail] && index[newEmail] !== pilotId) {
      throw new HttpError(409, "PILOT_EMAIL_TAKEN", "Email already belongs to another pilot");
    }
    delete index[oldEmail];
    index[newEmail] = pilotId;
    await writePrivateJson("pilot-email-index.json", StringRecordSchema, index, leaseId);
  });
}

async function markAuthEmailUnverified(userId: string): Promise<void> {
  const authPath = `auth/${userId}.json`;
  try {
    await withPrivateLeaseRetry(authPath, async (leaseId) => {
      const credential = await readJson(
        getPrivateBlobClient(authPath),
        AuthCredentialSchema,
        authPath,
      );
      credential.emailVerified = false;
      credential.tokenVersion = (credential.tokenVersion ?? 0) + 1;
      await writePrivateJson(authPath, AuthCredentialSchema, credential, leaseId);
    });
  } catch (err: unknown) {
    if (statusCodeOf(err) === 404) return;
    throw err;
  }
}

async function bestEffortDeleteAuthArtifacts(
  userId: string,
  ctx: InvocationContext,
  source = "updateUserEmail",
): Promise<void> {
  try {
    await getPrivateBlobClient(`auth/verification-state/${userId}.json`).deleteIfExists();
    const container = getPrivateContainer();
    for await (const item of container.listBlobsFlat({ prefix: "auth/tokens/" })) {
      await deleteTokenIfOwnedBy(item.name, userId, ctx, source);
    }
  } catch (err: unknown) {
    ctx.warn(`[${source}] auth artifact GC failed for ${userId}: ${String(err)}`);
  }
}

async function deleteTokenIfOwnedBy(
  path: string,
  userId: string,
  ctx: InvocationContext,
  source: string,
): Promise<void> {
  try {
    const token = await readJson(
      getPrivateBlobClient(path),
      AuthTokenUserSchema,
      path,
    );
    if (token.userId === userId) {
      await getPrivateBlobClient(path).deleteIfExists();
    }
  } catch (err: unknown) {
    ctx.warn(`[${source}] auth token GC skipped ${path}: ${String(err)}`);
  }
}

// ─── DELETE /api/manage/users/{userId} ───────────────────────────────────────

async function deleteUser(
  req: HttpRequest,
  ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isAdmin(caller.roles)) return forbiddenResponse();
  await mutationRateLimit(req, caller, "deleteUser", "standard");

  const userId = req.params["userId"];
  if (!userId) throw new HttpError(400, "MISSING_USER_ID", "Missing userId");
  if (userId === caller.userId) {
    throw new HttpError(400, "CANNOT_DELETE_SELF", "Cannot delete your own account");
  }

  try {
    await withAccountMutationLock(async () => {
      const tombstonePath = `users/deleted/${userId}.json`;
      const existingTombstone = await readDeletedUserTombstone(tombstonePath);
      let tombstone = existingTombstone;

      if (!tombstone) {
        const user = await readDeleteTargetUser(userId);
        if (user.roles.includes("Admin")) {
          await assertNotLastAdmin(userId);
        }
        tombstone = {
          email: user.email,
          pilotId: user.pilotId,
          deletedAt: new Date().toISOString(),
        };
        await createDeletedUserTombstone(tombstonePath, tombstone);
      }

      await removeUserIndexEntry(userId, tombstone.email ?? null);
      await deleteRequiredAccountAuthBlobs(userId);
      await bestEffortDeleteAuthArtifacts(userId, ctx, "deleteUser");

      if (tombstone.pilotId) {
        await unlinkPilotAccount(tombstone.pilotId);
        await removePilotEmailIndexEntry(tombstone.pilotId);
      }

      await getPrivateBlobClient(`users/${userId}.json`).deleteIfExists();
    });
  } catch (err: unknown) {
    if (err instanceof HttpError) throw err;
    rethrowLeaseConflict(err);
  }

  return { status: 204 };
}

async function readDeletedUserTombstone(path: string): Promise<DeletedUserTombstone | null> {
  try {
    return await readJson(getPrivateBlobClient(path), DeletedUserTombstoneSchema, path);
  } catch (err: unknown) {
    if (statusCodeOf(err) === 404) return null;
    throw err;
  }
}

async function readDeleteTargetUser(userId: string): Promise<User> {
  const userPath = `users/${userId}.json`;
  try {
    return await readJson(getPrivateBlobClient(userPath), UserSchema, userPath);
  } catch (err: unknown) {
    if (statusCodeOf(err) === 404) {
      throw new HttpError(404, "NOT_FOUND", "User not found");
    }
    throw err;
  }
}

async function createDeletedUserTombstone(
  path: string,
  tombstone: DeletedUserTombstone,
): Promise<void> {
  try {
    await writePrivateJson(path, DeletedUserTombstoneSchema, tombstone, undefined, { ifNoneMatch: "*" });
  } catch (err: unknown) {
    const status = statusCodeOf(err);
    if (status === 409 || status === 412) return;
    throw err;
  }
}

async function removeUserIndexEntry(
  userId: string,
  email: string | null,
): Promise<void> {
  await ensurePrivateBlob("user-index.json", StringRecordSchema, {});
  await withPrivateLeaseRetry("user-index.json", async (leaseId) => {
    const index = await readJson(
      getPrivateBlobClient("user-index.json"),
      StringRecordSchema,
      "user-index.json",
    );
    const lowerEmail = email?.toLowerCase() ?? null;
    if (lowerEmail && index[lowerEmail] === userId) {
      delete index[lowerEmail];
    }
    for (const [key, value] of Object.entries(index)) {
      if (value === userId) delete index[key];
    }
    await writePrivateJson("user-index.json", StringRecordSchema, index, leaseId);
  });
}

async function deleteRequiredAccountAuthBlobs(userId: string): Promise<void> {
  await getPrivateBlobClient(`auth/${userId}.json`).deleteIfExists();
  await getPrivateBlobClient(`auth/verification-state/${userId}.json`).deleteIfExists();
}

async function unlinkPilotAccount(pilotId: string): Promise<void> {
  const pilotPath = `pilots/${pilotId}.json`;
  try {
    await withPrivateLeaseRetry(pilotPath, async (leaseId) => {
      const pilot = await readJson(getPrivateBlobClient(pilotPath), PilotSchema, pilotPath);
      await writePrivateJson(pilotPath, PilotSchema, { ...pilot, userId: null }, leaseId);
    });
  } catch (err: unknown) {
    if (statusCodeOf(err) === 404) return;
    throw err;
  }
}

async function removePilotEmailIndexEntry(pilotId: string): Promise<void> {
  await ensurePrivateBlob("pilot-email-index.json", StringRecordSchema, {});
  await withPrivateLeaseRetry("pilot-email-index.json", async (leaseId) => {
    const index = await readJson(
      getPrivateBlobClient("pilot-email-index.json"),
      StringRecordSchema,
      "pilot-email-index.json",
    );
    for (const [key, value] of Object.entries(index)) {
      if (value === pilotId) delete index[key];
    }
    await writePrivateJson("pilot-email-index.json", StringRecordSchema, index, leaseId);
  });
}

// ─── POST /api/manage/users/{userId}/verify-email ────────────────────────────

async function adminVerifyEmail(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isAdmin(caller.roles)) return forbiddenResponse();
  await mutationRateLimit(req, caller, "adminVerifyEmail", "standard");

  const userId = req.params["userId"];
  if (!userId) throw new HttpError(400, "MISSING_USER_ID", "Missing userId");

  const credPath = `auth/${userId}.json`;
  try {
    await withPrivateLease(credPath, async (leaseId) => {
      let cred;
      try {
        cred = await readJson(
          getPrivateBlobClient(credPath),
          AuthCredentialSchema,
          credPath,
        );
      } catch (err: unknown) {
        if (statusCodeOf(err) === 404) {
          throw new HttpError(404, "NOT_FOUND", "Auth credential not found");
        }
        throw err;
      }

      cred.emailVerified = true;
      await writePrivateJson(credPath, AuthCredentialSchema, cred, leaseId);
    });
  } catch (err: unknown) {
    if (err instanceof HttpError) throw err;
    if (statusCodeOf(err) === 404) {
      throw new HttpError(404, "NOT_FOUND", "Auth credential not found");
    }
    rethrowLeaseConflict(err);
  }

  return { status: 200, jsonBody: { ok: true } };
}

// ─── POST /api/manage/users/{userId}/pilot ───────────────────────────────────

async function adminCreatePilotForUser(
  req: HttpRequest,
  _ctx: InvocationContext
): Promise<HttpResponseInit> {
  const caller = await getCallerIdentity(req);
  if (!caller) return unauthorizedResponse();
  if (!isAdmin(caller.roles)) return forbiddenResponse();
  await mutationRateLimit(req, caller, "adminCreatePilotForUser", "standard");

  const userId = req.params["userId"];
  if (!userId) throw new HttpError(400, "MISSING_USER_ID", "Missing userId");

  const names = await parseAdminPilotNames(req);
  let result: { status: 200 | 201; pilot: Pilot } | null = null;

  try {
    result = await withAccountMutationLock(async () => {
      const user = await readAdminPilotTargetUser(userId);
      const pilotId = deterministicPilotId(userId);

      if (user.pilotId) {
        if (user.pilotId !== pilotId) {
          throw new HttpError(409, "ALREADY_LINKED", "User is already linked to a different pilot");
        }
        const pilot = await ensureAdminPilotExists({ pilotId, user, names, updatedBy: caller.userId });
        await upsertAdminPilotInIndex(pilot);
        await claimPilotEmailForAdminUser(user.email, pilotId);
        return { status: 200, pilot };
      }

      await claimPilotEmailForAdminUser(user.email, pilotId);
      const pilot = buildAdminPilot({ pilotId, user, names, updatedBy: caller.userId });
      await writePrivateJson(`pilots/${pilotId}.json`, PilotSchema, pilot);
      await upsertAdminPilotInIndex(pilot);
      await linkAdminUserToPilotLast(userId, pilotId);
      return { status: 201, pilot };
    });
  } catch (err: unknown) {
    if (err instanceof HttpError) throw err;
    if (statusCodeOf(err) === 404) {
      throw new HttpError(404, "NOT_FOUND", "User not found");
    }
    rethrowLeaseConflict(err);
  }

  if (!result) throw new HttpError(500, "INTERNAL");
  return { status: result.status, jsonBody: { pilot: result.pilot } };
}

interface AdminPilotNames {
  firstName: string;
  lastName: string;
}

interface BuildAdminPilotInput {
  pilotId: string;
  user: User;
  names: AdminPilotNames;
  updatedBy: string;
}

async function parseAdminPilotNames(req: HttpRequest): Promise<AdminPilotNames> {
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON");
  }

  const parsed = AdminCreatePilotBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    throw new HttpError(400, "INVALID_NAME", "firstName and lastName are required");
  }

  const firstName = parsed.data.firstName.trim();
  const lastName = parsed.data.lastName.trim();
  if (!firstName || !lastName) {
    throw new HttpError(400, "INVALID_NAME", "firstName and lastName are required");
  }
  return { firstName, lastName };
}

async function readAdminPilotTargetUser(userId: string): Promise<User> {
  const userPath = `users/${userId}.json`;
  try {
    return await readJson(getPrivateBlobClient(userPath), UserSchema, userPath);
  } catch (err: unknown) {
    if (statusCodeOf(err) === 404) {
      throw new HttpError(404, "NOT_FOUND", "User not found");
    }
    throw err;
  }
}

function deterministicPilotId(userId: string): string {
  const hex = createHash("sha256").update(`admin-pilot:${userId}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function claimPilotEmailForAdminUser(email: string, pilotId: string): Promise<void> {
  const emailKey = email.toLowerCase();
  await ensurePrivateJsonIndexBlob("pilot-email-index.json", "{}");
  await withPrivateLeaseRetry("pilot-email-index.json", async (leaseId) => {
    let index: PilotEmailIndex = {};
    try {
      index = await readJson(
        getPrivateBlobClient("pilot-email-index.json"),
        StringRecordSchema,
        "pilot-email-index.json",
      );
    } catch (err: unknown) {
      if (statusCodeOf(err) !== 404) throw err;
    }

    const existingPilotId = index[emailKey];
    if (existingPilotId && existingPilotId !== pilotId) {
      throw new HttpError(409, "PILOT_EMAIL_TAKEN", "Email already belongs to another pilot");
    }
    index[emailKey] = pilotId;
    await writePrivateJson("pilot-email-index.json", StringRecordSchema, index, leaseId);
  });
}

async function ensureAdminPilotExists(input: BuildAdminPilotInput): Promise<Pilot> {
  const pilotPath = `pilots/${input.pilotId}.json`;
  try {
    return await readJson(getPrivateBlobClient(pilotPath), PilotSchema, pilotPath);
  } catch (err: unknown) {
    if (statusCodeOf(err) !== 404) throw err;
  }

  const pilot = buildAdminPilot(input);
  await writePrivateJson(pilotPath, PilotSchema, pilot);
  return pilot;
}

function buildAdminPilot(input: BuildAdminPilotInput): Pilot {
  const now = new Date().toISOString();
  const fullName = `${input.names.firstName} ${input.names.lastName}`;
  return {
    id: input.pilotId,
    legacyId: null,
    coachType: "None",
    pilotRating: "Pilot",
    person: {
      id: randomUUID(),
      firstName: input.names.firstName,
      lastName: input.names.lastName,
      fullName,
    },
    seasonClubs: [],
    userId: input.user.id,
    createdAt: now,
    updatedAt: now,
    updatedBy: input.updatedBy,
    profileUpdatedAt: now,
  };
}

async function upsertAdminPilotInIndex(pilot: Pilot): Promise<void> {
  await ensureJsonIndexBlob("pilots.json", "[]");
  await withLeaseRetry("pilots.json", async (leaseId) => {
    let index: PilotSummary[] = [];
    try {
      index = await readJson(
        getBlobClient("pilots.json"),
        PilotsIndexSchema,
        "pilots.json",
      );
    } catch (err: unknown) {
      if (statusCodeOf(err) !== 404) throw err;
    }

    const entry: PilotSummary = {
      id: pilot.id,
      legacyId: pilot.legacyId,
      name: pilot.person.fullName,
      clubId: undefined,
      rating: pilot.pilotRating,
    };
    const idx = index.findIndex((p) => p.id === pilot.id);
    if (idx >= 0) {
      index[idx] = entry;
    } else {
      index.push(entry);
    }
    index.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

    await writeBlob("pilots.json", index, leaseId);
  });
}

async function linkAdminUserToPilotLast(userId: string, pilotId: string): Promise<void> {
  const userPath = `users/${userId}.json`;
  await withPrivateLeaseRetry(userPath, async (leaseId) => {
    const user = await readJson(getPrivateBlobClient(userPath), UserSchema, userPath);
    if (user.pilotId && user.pilotId !== pilotId) {
      throw new HttpError(409, "ALREADY_LINKED", "User is already linked to a different pilot");
    }
    const updated: User = {
      ...user,
      pilotId,
      roles: user.roles.includes("Pilot") ? user.roles : [...user.roles, "Pilot"],
    };
    await writePrivateJson(userPath, UserSchema, updated, leaseId);
  });
}

// ─── Registration ─────────────────────────────────────────────────────────────

app.http("recomputeRound", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "manage/rounds/{id}/recompute",
  handler: withErrorHandler(recomputeRound),
});

app.http("getConfig", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "manage/config",
  handler: withErrorHandler(getConfig),
});

app.http("updateConfig", {
  methods: ["PUT"],
  authLevel: "anonymous",
  route: "manage/config",
  handler: withErrorHandler(updateConfig),
});

app.http("listUsers", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "manage/users",
  handler: withErrorHandler(listUsers),
});

app.http("setUserRoles", {
  methods: ["PUT"],
  authLevel: "anonymous",
  route: "manage/users/{userId}/roles",
  handler: withErrorHandler(setUserRoles),
});

app.http("updateUserEmail", {
  methods: ["PUT"],
  authLevel: "anonymous",
  route: "manage/users/{userId}/email",
  handler: withErrorHandler(updateUserEmail),
});

app.http("deleteUser", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "manage/users/{userId}",
  handler: withErrorHandler(deleteUser),
});

app.http("adminVerifyEmail", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "manage/users/{userId}/verify-email",
  handler: withErrorHandler(adminVerifyEmail),
});

app.http("adminCreatePilotForUser", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "manage/users/{userId}/pilot",
  handler: withErrorHandler(adminCreatePilotForUser),
});
