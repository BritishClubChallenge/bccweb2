// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * admin.ts — email-change re-verification link (issue #122, T6).
 *
 * updateUserEmail resets emailVerified=false (markAuthEmailUnverified) and used
 * to send NOTHING, locking the user out of the new address. It now auto-sends a
 * verification link to the NEW address.
 *
 * Test B is the ordering guard: the token is minted AFTER the auth-artifact GC
 * and AFTER the tokenVersion bump, so it survives the sweep and matches
 * cred.tokenVersion. Minting it earlier would make authVerifyEmail return 400
 * (deleted token / version mismatch) — a permanent lockout.
 */

import { afterEach, describe, expect, test, beforeEach } from "vitest";
import { getRegisteredHandler, getSentEmails, clearSentEmails } from "../../__tests__/helpers/setup.js";
import { makeAuthRequest, makeRequest } from "../../__tests__/helpers/api.js";
import { bootstrapAdmin, makeUser, readPrivateJson } from "../../__tests__/helpers/seed.js";
import { verificationStatePath, type VerificationState, type AuthCredential } from "../../lib/authHelpers.js";
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

const PUBLIC_ORIGIN = "https://public.example.test";
const FUNCTION_HOST = "func.example.test";
const originalAppUrl = process.env["APP_URL"];
const originalWebsiteHostname = process.env["WEBSITE_HOSTNAME"];

function restoreEnv(name: "APP_URL" | "WEBSITE_HOSTNAME", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function invoke(
  name: string,
  req: ReturnType<typeof makeAuthRequest>,
): Promise<HandlerResult> {
  const entry = getRegisteredHandler(name);
  if (!entry) throw new Error(`${name} not registered`);
  return (await entry.handler(req, ctx)) as HandlerResult;
}

describe("PUT /api/manage/users/{userId}/email — issue #122 re-verification link (T6)", () => {
  beforeEach(() => {
    process.env["APP_URL"] = PUBLIC_ORIGIN;
    process.env["WEBSITE_HOSTNAME"] = FUNCTION_HOST;
    clearSentEmails();
  });

  afterEach(() => {
    restoreEnv("APP_URL", originalAppUrl);
    restoreEnv("WEBSITE_HOSTNAME", originalWebsiteHostname);
  });

  test("A: a verification link is emailed to the NEW address", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: target } = await makeUser({ emailVerified: true });

    const newEmail = `reverify-${target.id.slice(0, 8)}@example.com`;
    const res = await invoke(
      "updateUserEmail",
      makeAuthRequest(admin.id, admin.email, {
        method: "PUT",
        params: { userId: target.id },
        body: { email: newEmail },
      }),
    );
    expect(res.status).toBe(200);

    const lastEmail = getSentEmails().at(-1);
    expect(lastEmail).toBeDefined();
    expect(lastEmail!.to).toContain(newEmail);
    expect(lastEmail!.subject).toMatch(/verify/i);
    const expectedPrefix = `${PUBLIC_ORIGIN}/verify-email?token=`;
    expect(lastEmail!.html).toContain(expectedPrefix);
    expect(lastEmail!.text).toContain(expectedPrefix);
    expect(lastEmail!.html).not.toContain(FUNCTION_HOST);
    expect(lastEmail!.text).not.toContain(FUNCTION_HOST);
  });

  test("B: the emitted token verifies (locks the GC-then-create ordering)", async () => {
    const { user: admin } = await bootstrapAdmin();
    const { user: target } = await makeUser({ emailVerified: true });

    const newEmail = `reverify-${target.id.slice(0, 8)}@example.com`;
    const changeRes = await invoke(
      "updateUserEmail",
      makeAuthRequest(admin.id, admin.email, {
        method: "PUT",
        params: { userId: target.id },
        body: { email: newEmail },
      }),
    );
    expect(changeRes.status).toBe(200);

    const state = await readPrivateJson<VerificationState>(verificationStatePath(target.id));
    expect(state?.token).toBeTruthy();
    const token = state!.token;

    const verifyRes = await invoke(
      "authVerifyEmail",
      makeRequest({ method: "GET", query: { token } }),
    );
    expect(verifyRes.status).toBe(200);

    const cred = await readPrivateJson<AuthCredential>(`auth/${target.id}.json`);
    expect(cred?.emailVerified).toBe(true);
  });
});
