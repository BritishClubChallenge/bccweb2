#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * admin-users.mjs
 *
 * Admin utility for managing users in blob storage.
 *
 * Commands:
 *   list                        List all users (id, email, roles, pilotId, createdAt)
 *   find <email>                Show full user.json and auth credential for a user
 *   reset-password <email>      Set a new password for a user (prompts for input)
 *
 * Usage:
 *   BLOB_CONNECTION_STRING="..." node scripts/admin-users.mjs list
 *   BLOB_STORAGE_ACCOUNT_NAME="stbccwebstagingdata" node scripts/admin-users.mjs list
 *   BLOB_CONNECTION_STRING="..." node scripts/admin-users.mjs find user@example.com
 *   BLOB_CONNECTION_STRING="..." node scripts/admin-users.mjs reset-password user@example.com
 *
 * All user/auth data lives in the private container (default "data-private").
 * Override with BLOB_PRIVATE_CONTAINER_NAME env var if needed.
 *
 * For local Azurite:
 *   BLOB_CONNECTION_STRING="DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;" \
 *   node scripts/admin-users.mjs list
 */

import bcrypt from "bcryptjs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, exit } from "node:process";
import {
  createBlobServiceClient,
  preflightBlobReadAccess,
} from "./lib/storageClients.mjs";

// ─── Config ──────────────────────────────────────────────────────────────────

const AZURITE_DEV_CS =
  "DefaultEndpointsProtocol=http;" +
  "AccountName=devstoreaccount1;" +
  "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;" +
  "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";

const RAW_BLOB_CS = process.env.BLOB_CONNECTION_STRING;
const BLOB_CS = RAW_BLOB_CS
  ? RAW_BLOB_CS
  : process.env.BLOB_STORAGE_ACCOUNT_NAME
    ? undefined
    : AZURITE_DEV_CS;
const PRIVATE_CONTAINER = process.env.BLOB_PRIVATE_CONTAINER_NAME ?? "data-private";
const BCRYPT_COST = 12;

if (!RAW_BLOB_CS && !process.env.BLOB_STORAGE_ACCOUNT_NAME) {
  console.error(
    "Note: BLOB_CONNECTION_STRING not set — using local Azurite (127.0.0.1:10000).",
  );
} else if (RAW_BLOB_CS && RAW_BLOB_CS !== BLOB_CS) {
  console.error(
    "Note: rewrote BlobEndpoint host `azurite` → `127.0.0.1` for host-shell use.",
  );
}

const blobService = createBlobServiceClient({ connectionString: BLOB_CS });
const container = blobService.getContainerClient(PRIVATE_CONTAINER);

// ─── Blob helpers ─────────────────────────────────────────────────────────────

async function readBlob(path) {
  const client = container.getBlobClient(path);
  try {
    const download = await client.download();
    const chunks = [];
    for await (const chunk of download.readableStreamBody) {
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

async function writeBlob(path, data) {
  const client = container.getBlockBlobClient(path);
  const content = JSON.stringify(data, null, 2);
  const contentBytes = Buffer.from(content, "utf8");
  await client.upload(contentBytes, contentBytes.length, {
    blobHTTPHeaders: { blobContentType: "application/json" },
    overwrite: true,
  });
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdList() {
  const index = await readBlob("user-index.json");
  if (!index || Object.keys(index).length === 0) {
    console.log("No users found.");
    return;
  }

  const users = [];
  for (const [, userId] of Object.entries(index)) {
    const user = await readBlob(`users/${userId}.json`);
    if (user) users.push(user);
  }

  // Sort by createdAt ascending
  users.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const col = (s, w) => String(s ?? "").padEnd(w).slice(0, w);

  console.log(
    `\n${"ID".padEnd(36)}  ${"EMAIL".padEnd(40)}  ${"ROLES".padEnd(24)}  CREATED`
  );
  console.log("─".repeat(120));
  for (const u of users) {
    const roles = (u.roles ?? []).join(", ") || "(none)";
    console.log(
      `${col(u.id, 36)}  ${col(u.email, 40)}  ${col(roles, 24)}  ${u.createdAt}`
    );
  }
  console.log(`\n${users.length} user(s) total.\n`);
}

async function cmdFind(email) {
  if (!email) {
    console.error("Usage: admin-users.mjs find <email>");
    exit(1);
  }

  const index = await readBlob("user-index.json");
  const userId = index?.[email.toLowerCase()];

  if (!userId) {
    console.error(`No user found with email: ${email}`);
    exit(1);
  }

  const user = await readBlob(`users/${userId}.json`);
  const cred = await readBlob(`auth/${userId}.json`);

  console.log("\n── user.json ────────────────────────────────────");
  console.log(JSON.stringify(user, null, 2));

  if (cred) {
    console.log("\n── auth credential ──────────────────────────────");
    console.log(JSON.stringify(cred, null, 2));
  } else {
    console.log("\n── auth credential ──────────────────────────────");
    console.log("(not found)");
  }
  console.log();
}

const VALID_ROLES = ["Admin", "RoundsCoord", "Pilot"];

async function cmdSetRoles(email, roleArgs) {
  if (!email || roleArgs.length === 0) {
    console.error(`Usage: admin-users.mjs set-roles <email> <role> [role...]`);
    console.error(`Roles: ${VALID_ROLES.join(", ")}`);
    exit(1);
  }

  const invalid = roleArgs.filter((r) => !VALID_ROLES.includes(r));
  if (invalid.length > 0) {
    console.error(`Invalid role(s): ${invalid.join(", ")}`);
    console.error(`Valid roles: ${VALID_ROLES.join(", ")}`);
    exit(1);
  }

  const index = await readBlob("user-index.json");
  const userId = index?.[email.toLowerCase()];

  if (!userId) {
    console.error(`No user found with email: ${email}`);
    exit(1);
  }

  const user = await readBlob(`users/${userId}.json`);
  const before = (user.roles ?? []).join(", ") || "(none)";
  const after = roleArgs.join(", ");

  await writeBlob(`users/${userId}.json`, { ...user, roles: roleArgs });
  console.log(`Roles updated for ${user.email}`);
  console.log(`  before: ${before}`);
  console.log(`  after:  ${after}`);
}

async function cmdVerify(email) {
  if (!email) {
    console.error("Usage: admin-users.mjs verify <email>");
    exit(1);
  }

  const index = await readBlob("user-index.json");
  const userId = index?.[email.toLowerCase()];

  if (!userId) {
    console.error(`No user found with email: ${email}`);
    exit(1);
  }

  const cred = await readBlob(`auth/${userId}.json`);
  if (!cred) {
    console.error(`Auth credential not found for: ${email} (${userId})`);
    exit(1);
  }

  if (cred.emailVerified) {
    console.log(`Already verified: ${email}`);
    return;
  }

  await writeBlob(`auth/${userId}.json`, { ...cred, emailVerified: true });
  console.log(`Email verified for: ${email}`);
}

async function cmdResetPassword(email) {
  if (!email) {
    console.error("Usage: admin-users.mjs reset-password <email>");
    exit(1);
  }

  const index = await readBlob("user-index.json");
  const userId = index?.[email.toLowerCase()];

  if (!userId) {
    console.error(`No user found with email: ${email}`);
    exit(1);
  }

  const user = await readBlob(`users/${userId}.json`);
  const cred = await readBlob(`auth/${userId}.json`);

  if (!cred) {
    console.error(`Auth credential not found for user: ${email} (${userId})`);
    exit(1);
  }

  console.log(`\nResetting password for: ${user.email} (${user.id})`);

  const rl = createInterface({ input: stdin, output: stdout });
  let password;
  try {
    password = await rl.question("New password: ");
  } finally {
    rl.close();
  }

  if (!password || password.length < 8) {
    console.error("Password must be at least 8 characters.");
    exit(1);
  }

  console.log("Hashing password…");
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

  const updated = { ...cred, passwordHash };
  await writeBlob(`auth/${userId}.json`, updated);

  console.log(`Password reset successfully for ${user.email}.\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const [, , command, arg, ...rest] = process.argv;

const commands = {
  list: () => cmdList(),
  find: () => cmdFind(arg),
  verify: () => cmdVerify(arg),
  "set-roles": () => cmdSetRoles(arg, rest),
  "reset-password": () => cmdResetPassword(arg),
};

if (!command || !commands[command]) {
  console.error(`Usage: admin-users.mjs <command> [args]

Commands:
  list                           List all users
  find <email>                   Show user.json and auth credential for a user
  verify <email>                 Mark a user's email as verified (bypasses email flow)
  set-roles <email> <role>...    Set roles for a user (replaces existing)
  reset-password <email>         Reset a user's password

Roles: ${VALID_ROLES.join(", ")}
`);
  exit(1);
}

preflightBlobReadAccess({ container, connectionString: BLOB_CS })
  .then(() => commands[command]())
  .catch((err) => {
    console.error(`Error: ${err.message}`);
    exit(1);
  });
