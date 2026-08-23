#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * seed-admin.mjs
 *
 * Idempotent admin bootstrap for the local dev stack.
 *
 * Behaviour:
 *   - Reads `user-index.json` from the private container.
 *   - If `admin@bcc.local` already exists → log to STDERR (yellow) and exit 0.
 *   - Otherwise:
 *       1. Generate a random 16-char password.
 *       2. Compute a deterministic userId via `deterministicUuid("admin-user", ADMIN_EMAIL)`.
 *       3. Bcrypt-hash the password ONCE (cost 12).
 *       4. Write `auth/{userId}.json` with `emailVerified: true`.
 *       5. Write `users/{userId}.json` with `roles: ["Admin"]` and
 *          `acceptedTsCsVersion: TS_CS_VERSION` (so the SPA doesn't block on T&Cs).
 *       6. Re-read `user-index.json` (refresh in case of race), merge in the new
 *          entry, write back.
 *       7. Write `.dev-credentials` (mode 0600) with the credentials so other
 *          scripts (e.g. `make e2e`) can pick them up.
 *
 * Output rules:
 *   - Status output goes to STDERR. STDOUT stays clean so
 *     compose log integration (T14) can redirect freely.
 *   - The password is NEVER logged or written to a blob.
 *
 * Usage:
 *   node scripts/seed-admin.mjs
 *
 * Env (all optional, sensible Azurite defaults):
 *   BLOB_CONNECTION_STRING          Azurite/Azure connection string
 *   BLOB_STORAGE_ACCOUNT_NAME       Remote data account (uses invoking Entra identity)
 *   BLOB_PRIVATE_CONTAINER_NAME     Defaults to "data-private"
 */

import {
  getPrivateContainer,
  readJson,
  writeJson,
  precomputeBcryptHash,
  compareBcryptPassword,
  deterministicUuid,
} from "./lib/blobSeed.mjs";
import {
  ADMIN_EMAIL,
  TS_CS_VERSION,
} from "./lib/loadTestConsts.mjs";
import {
  devCredentialsPath,
  readInitializedDevCredentials,
  prepareDevCredentialsFile,
  writeDevCredentials,
} from "./lib/devCredentials.mjs";
import { randomBytes } from "node:crypto";

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const prepareOnly = process.argv.includes("--prepare-credentials");
  const credentialPath = devCredentialsPath();
  const override = process.env.ADMIN_PASSWORD;
  const existingCredentials = readInitializedDevCredentials(credentialPath);
  if (existingCredentials && existingCredentials.email !== ADMIN_EMAIL) {
    throw new Error(`seed-admin: admin credential email must be ${ADMIN_EMAIL}`);
  }
  if (prepareOnly) {
    if (override && existingCredentials && existingCredentials.password !== override) {
      throw new Error("seed-admin: ADMIN_PASSWORD conflicts with initialized .dev-credentials");
    }
    if (override && !existingCredentials) {
      writeDevCredentials({ email: ADMIN_EMAIL, password: override }, credentialPath);
    } else if (!override) {
      prepareDevCredentialsFile(credentialPath);
    }
    process.stderr.write(`[seed-admin] private admin credential is ready at ${credentialPath}.\n`);
    return;
  }

  const privateContainer = getPrivateContainer();

  const existingIndex =
    (await readJson(privateContainer, "user-index.json")) ?? {};

  if (existingIndex[ADMIN_EMAIL]) {
    const password = override ?? existingCredentials?.password;
    if (!password) {
      throw new Error("seed-admin: existing admin requires ADMIN_PASSWORD or an initialized .dev-credentials file");
    }
    const credential = await readJson(privateContainer, `auth/${existingIndex[ADMIN_EMAIL]}.json`);
    if (typeof credential?.passwordHash !== "string" || !(await compareBcryptPassword(password, credential.passwordHash))) {
      throw new Error("seed-admin: credential does not match existing admin");
    }
    process.stderr.write(
      `[seed-admin] ${ADMIN_EMAIL} already exists; admin credential source is available.\n`
    );
    return;
  }

  const password = override ?? existingCredentials?.password ?? randomBytes(12).toString("base64url").slice(0, 16);
  if (!override && !existingCredentials) {
    writeDevCredentials({ email: ADMIN_EMAIL, password }, credentialPath);
  }

  // Cold-run path — create the admin.
  const userId = deterministicUuid("admin-user", ADMIN_EMAIL);
  const now = new Date().toISOString();

  // ONE bcrypt call (cost 12 → ~250-400ms).
  const passwordHash = await precomputeBcryptHash(password);

  await writeJson(privateContainer, `auth/${userId}.json`, {
    passwordHash,
    emailVerified: true,
    createdAt: now,
  });

  await writeJson(privateContainer, `users/${userId}.json`, {
    id: userId,
    email: ADMIN_EMAIL,
    roles: ["Admin"],
    createdAt: now,
    acceptedTsCsVersion: TS_CS_VERSION,
  });

  // Re-read (refresh) the index to minimise the race window with any
  // concurrent writer, then merge in our entry and write back.
  const refreshedIndex =
    (await readJson(privateContainer, "user-index.json")) ?? {};
  refreshedIndex[ADMIN_EMAIL] = userId;
  await writeJson(privateContainer, "user-index.json", refreshedIndex);

  const source = override ? "ADMIN_PASSWORD override" : `private credential at ${credentialPath}`;
  process.stderr.write(`[seed-admin] OK: ${ADMIN_EMAIL}; using ${source}.\n`);
}

main().catch((err) => {
  process.stderr.write(
    `seed-admin: ${err?.stack ?? err?.message ?? String(err)}\n`
  );
  process.exit(1);
});
