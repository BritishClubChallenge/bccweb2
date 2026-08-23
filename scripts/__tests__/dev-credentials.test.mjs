// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  readDevCredentials,
  readInitializedDevCredentials,
  writeDevCredentials,
} from "../lib/devCredentials.mjs";
import { buildLoadTestManifest } from "../lib/loadTestTopology.mjs";

const SEED_ROUNDS_SCRIPT = resolve("scripts/seed-rounds.mjs");
const SEED_ADMIN_SCRIPT = resolve("scripts/seed-admin.mjs");
const MAKEFILE = resolve("Makefile");
const TEST_PASSWORD = "fixture-admin-password";

function cleanEnvironment(overrides = {}) {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "ADMIN_PASSWORD")),
    ...overrides,
  };
}

async function fixtureDir(t) {
  const cwd = await mkdtemp(join(tmpdir(), "bcc-dev-credentials-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "tests/load"), { recursive: true });
  const manifest = buildLoadTestManifest({ seasonYear: new Date().getFullYear(), siteNames: ["Site Alpha"] });
  await writeFile(join(cwd, ".fixture-manifest.json"), JSON.stringify(manifest));
  return cwd;
}

async function noHttpHook(cwd) {
  const callsPath = join(cwd, "http-called");
  const hookPath = join(cwd, "fetch-hook.mjs");
  await writeFile(
    hookPath,
    `import { writeFileSync } from "node:fs";
globalThis.fetch = async () => {
  writeFileSync(${JSON.stringify(callsPath)}, "called");
  return new Response("unexpected", { status: 500 });
};
`,
  );
  return { callsPath, hookPath };
}

function runSeedRounds(cwd, hookPath, overrides = {}) {
  return spawnSync(process.execPath, ["--import", hookPath, SEED_ROUNDS_SCRIPT], {
    cwd,
    env: cleanEnvironment(overrides),
    encoding: "utf8",
  });
}

async function assertRejectedBeforeHttp(t, arrangeCredential, expectedError) {
  // Given
  const cwd = await fixtureDir(t);
  await arrangeCredential(cwd);
  const { callsPath, hookPath } = await noHttpHook(cwd);

  // When
  const result = runSeedRounds(cwd, hookPath);

  // Then
  assert.equal(result.status, 1);
  assert.match(result.stderr, expectedError);
  await assert.rejects(lstat(callsPath), { code: "ENOENT" });
  assert.doesNotMatch(result.stderr, new RegExp(TEST_PASSWORD, "u"));
}

test("seed-rounds fails before HTTP when the credential file is absent", async (t) => {
  await assertRejectedBeforeHttp(t, async () => {}, /missing admin credential/u);
});

test("seed-rounds rejects extra credential fields before HTTP", async (t) => {
  await assertRejectedBeforeHttp(t, async (cwd) => {
    const path = join(cwd, ".dev-credentials");
    await writeFile(path, `ADMIN_EMAIL=admin@bcc.local\nADMIN_PASSWORD=${TEST_PASSWORD}\nEXTRA=value\n`, { mode: 0o600 });
  }, /malformed admin credential/u);
});

test("seed-rounds rejects a different admin email before HTTP", async (t) => {
  await assertRejectedBeforeHttp(t, async (cwd) => {
    const path = join(cwd, ".dev-credentials");
    await writeFile(path, `ADMIN_EMAIL=other@bcc.local\nADMIN_PASSWORD=${TEST_PASSWORD}\n`, { mode: 0o600 });
  }, /admin credential email is invalid/u);
});

test("seed-rounds rejects a group-readable credential before HTTP", async (t) => {
  await assertRejectedBeforeHttp(t, async (cwd) => {
    const path = join(cwd, ".dev-credentials");
    await writeFile(path, `ADMIN_EMAIL=admin@bcc.local\nADMIN_PASSWORD=${TEST_PASSWORD}\n`, { mode: 0o600 });
    await chmod(path, 0o640);
  }, /mode 0600/u);
});

test("seed-rounds rejects a credential symlink before HTTP", async (t) => {
  await assertRejectedBeforeHttp(t, async (cwd) => {
    const target = join(cwd, "credential-target");
    await writeFile(target, `ADMIN_EMAIL=admin@bcc.local\nADMIN_PASSWORD=${TEST_PASSWORD}\n`, { mode: 0o600 });
    await symlink(target, join(cwd, ".dev-credentials"));
  }, /regular file/u);
});

test("seed-rounds rejects a hard-linked credential before HTTP", async (t) => {
  await assertRejectedBeforeHttp(t, async (cwd) => {
    const target = join(cwd, "credential-target");
    await writeFile(target, `ADMIN_EMAIL=admin@bcc.local\nADMIN_PASSWORD=${TEST_PASSWORD}\n`, { mode: 0o600 });
    await link(target, join(cwd, ".dev-credentials"));
  }, /single link/u);
});

test("seed-rounds preserves ownership state when credentials are malformed", async (t) => {
  // Given
  const cwd = await fixtureDir(t);
  const statePath = join(cwd, ".loadtest-round-state.json");
  const state = `${JSON.stringify({
    version: 2,
    seedRoundIds: [],
    loadRoundId: "load-preserved",
    loadTarget: "a".repeat(64),
  })}\n`;
  await writeFile(statePath, state, { mode: 0o600 });
  await writeFile(join(cwd, ".dev-credentials"), "not-a-credential\n", { mode: 0o600 });
  const { hookPath } = await noHttpHook(cwd);

  // When
  const result = runSeedRounds(cwd, hookPath);

  // Then
  assert.equal(result.status, 1);
  assert.match(result.stderr, /malformed admin credential/u);
  assert.equal(await readFile(statePath, "utf8"), state);
});

test("ADMIN_PASSWORD takes precedence without reading a malformed credential", async (t) => {
  // Given
  const cwd = await fixtureDir(t);
  await writeFile(join(cwd, ".dev-credentials"), "not-a-credential\n", { mode: 0o644 });
  const requestPath = join(cwd, "request.json");
  const hookPath = join(cwd, "fetch-hook.mjs");
  await writeFile(
    hookPath,
    `import { writeFileSync } from "node:fs";
globalThis.fetch = async (_url, init) => {
  writeFileSync(${JSON.stringify(requestPath)}, init.body);
  return new Response("stop-after-login", { status: 500 });
};
`,
  );

  // When
  const result = runSeedRounds(cwd, hookPath, { ADMIN_PASSWORD: TEST_PASSWORD });

  // Then
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(await readFile(requestPath, "utf8")).password, TEST_PASSWORD);
  assert.doesNotMatch(result.stderr, new RegExp(TEST_PASSWORD, "u"));
});

test("seed-rounds reads a valid generated credential for the login request", async (t) => {
  // Given
  const cwd = await fixtureDir(t);
  const credentialPath = join(cwd, ".dev-credentials");
  writeDevCredentials({ email: "admin@bcc.local", password: TEST_PASSWORD }, credentialPath);
  const requestPath = join(cwd, "request.json");
  const hookPath = join(cwd, "fetch-hook.mjs");
  await writeFile(
    hookPath,
    `import { writeFileSync } from "node:fs";
globalThis.fetch = async (_url, init) => {
  writeFileSync(${JSON.stringify(requestPath)}, init.body);
  return new Response("stop-after-login", { status: 500 });
};
`,
  );

  // When
  const result = runSeedRounds(cwd, hookPath);

  // Then
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(await readFile(requestPath, "utf8")).password, TEST_PASSWORD);
  assert.equal((await lstat(credentialPath)).mode & 0o777, 0o600);
  assert.doesNotMatch(result.stderr, new RegExp(TEST_PASSWORD, "u"));
});

test("credential writer initializes a private empty placeholder file", async (t) => {
  // Given
  const cwd = await fixtureDir(t);
  const credentialPath = join(cwd, ".dev-credentials");
  await writeFile(credentialPath, "", { mode: 0o600 });

  // When
  assert.equal(readInitializedDevCredentials(credentialPath), null);
  writeDevCredentials({ email: "admin@bcc.local", password: TEST_PASSWORD }, credentialPath);

  // Then
  assert.deepEqual(readDevCredentials(credentialPath), {
    email: "admin@bcc.local",
    password: TEST_PASSWORD,
  });
  assert.equal((await lstat(credentialPath)).mode & 0o777, 0o600);
});

test("credential writer refuses to replace an initialized artifact", async (t) => {
  // Given
  const cwd = await fixtureDir(t);
  const credentialPath = join(cwd, ".dev-credentials");
  writeDevCredentials({ email: "admin@bcc.local", password: TEST_PASSWORD }, credentialPath);

  // When / Then
  assert.throws(
    () => writeDevCredentials({ email: "admin@bcc.local", password: "replacement" }, credentialPath),
    /refusing to replace/u,
  );
  assert.equal(readDevCredentials(credentialPath).password, TEST_PASSWORD);
});

test("make seed bootstraps credentials before mutating fixture storage", async () => {
  // Given / When
  const makefile = await readFile(MAKEFILE, "utf8");
  const seedRecipe = makefile.match(/^seed:.*\n((?:\t.*\n)+)/mu)?.[1] ?? "";

  // Then
  assert.match(seedRecipe, /node scripts\/seed-admin\.mjs --prepare-credentials/u);
  assert.ok(seedRecipe.indexOf("seed-admin.mjs --prepare-credentials") < seedRecipe.indexOf("seed-fixtures.mjs"));
  assert.ok(seedRecipe.lastIndexOf("seed-admin.mjs") > seedRecipe.indexOf("seed-fixtures.mjs"));
  assert.doesNotMatch(seedRecipe, /ADMIN_PASSWORD\s*=/u);
});

test("dev-api startup prepares credentials without shell redirection", async () => {
  // Given / When
  const makefile = await readFile(MAKEFILE, "utf8");

  // Then
  assert.doesNotMatch(makefile, /: > \.dev-credentials/u);
  assert.equal((makefile.match(/seed-admin\.mjs --prepare-credentials/gu) ?? []).length >= 2, true);
});

test("prepare-credentials succeeds before storage is available", async (t) => {
  // Given
  const cwd = await fixtureDir(t);

  // When
  const result = spawnSync(process.execPath, [SEED_ADMIN_SCRIPT, "--prepare-credentials"], {
    cwd,
    env: cleanEnvironment({
      BLOB_CONNECTION_STRING: "DefaultEndpointsProtocol=http;AccountName=unavailable;AccountKey=unused;BlobEndpoint=http://127.0.0.1:1/unavailable;",
    }),
    encoding: "utf8",
  });

  // Then
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await lstat(join(cwd, ".dev-credentials"))).mode & 0o777, 0o600);
  assert.equal((await lstat(join(cwd, ".dev-credentials"))).size, 0);
});

test("prepare-credentials writes ADMIN_PASSWORD override to the safe bind file", async (t) => {
  // Given
  const cwd = await fixtureDir(t);
  const credentialPath = join(cwd, ".dev-credentials");

  // When
  const result = spawnSync(process.execPath, [SEED_ADMIN_SCRIPT, "--prepare-credentials"], {
    cwd,
    env: cleanEnvironment({ ADMIN_PASSWORD: TEST_PASSWORD }),
    encoding: "utf8",
  });

  // Then
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readDevCredentials(credentialPath), {
    email: "admin@bcc.local",
    password: TEST_PASSWORD,
  });
  assert.equal((await lstat(credentialPath)).mode & 0o777, 0o600);
  assert.doesNotMatch(result.stderr, new RegExp(TEST_PASSWORD, "u"));
});

test("existing admin rejects an unverified replacement credential", async () => {
  // Given / When
  const source = await readFile(SEED_ADMIN_SCRIPT, "utf8");

  // Then
  assert.match(source, /compareBcryptPassword/u);
  assert.match(source, /credential does not match existing admin/u);
});
