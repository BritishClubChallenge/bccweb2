// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import { createHash, randomUUID } from "crypto";
import jwt from "jsonwebtoken";
import {
  clearSentEmails,
  getRegisteredHandler,
  getSentEmails,
} from "../../__tests__/helpers/setup.js";
import { makeRequest } from "../../__tests__/helpers/api.js";
import {
  makeUser,
  readPrivateJson,
  writePrivateJson,
} from "../../__tests__/helpers/seed.js";
import { resetAllBuckets } from "../../lib/rateLimit.js";
import { generateShortLivedToken } from "../../lib/authHelpers.js";
import type { AuthCredential, AuthToken } from "../../lib/authHelpers.js";
import "../authFunctions.js";

interface HandlerResponse {
  status?: number;
  headers?: Record<string, string>;
  jsonBody?: Record<string, unknown>;
}

interface CredWithLockout extends AuthCredential {
  failedAttempts?: string[];
  lockedUntil?: string | null;
}

interface VerificationState {
  token: string;
  createdAt: string;
  expiresAt: string;
}

function ctxStub() {
  return {
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    invocationId: "test-inv",
    functionName: "test",
  } as never;
}

async function invoke(
  handlerName: string,
  init: {
    method?: string;
    body?: unknown;
    query?: Record<string, string>;
    headers?: Record<string, string>;
  } = {},
): Promise<HandlerResponse> {
  const entry = getRegisteredHandler(handlerName);
  if (!entry) throw new Error(`Handler "${handlerName}" not registered`);
  const req = makeRequest({
    method: init.method,
    body: init.body,
    query: init.query,
    headers: init.headers,
  });
  return (await entry.handler(req, ctxStub())) as HandlerResponse;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function verificationStatePath(userId: string): string {
  return `auth/verification-state/${userId}.json`;
}

async function seedStaleVerificationState(
  userId: string,
  token: string,
  ageMs: number,
): Promise<void> {
  const createdAt = new Date(Date.now() - ageMs).toISOString();
  const expiresAt = new Date(Date.now() + 24 * 3_600_000).toISOString();
  await writePrivateJson(verificationStatePath(userId), {
    token,
    createdAt,
    expiresAt,
  });
  await writePrivateJson(`auth/tokens/${sha256Hex(token)}.json`, {
    userId,
    type: "verify",
    expiresAt,
  });
}

async function seedExpiredVerifyToken(
  userId: string,
  token: string,
): Promise<void> {
  await writePrivateJson(`auth/tokens/${sha256Hex(token)}.json`, {
    userId,
    type: "verify",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
}

async function seedVerifyToken(
  userId: string,
  token: string,
  tokenVersion?: number,
): Promise<void> {
  await writePrivateJson(`auth/tokens/${sha256Hex(token)}.json`, {
    userId,
    type: "verify",
    expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
    ...(tokenVersion !== undefined && { tokenVersion }),
  });
}

const PASSWORD = "TestPass123!";
const PUBLIC_ORIGIN = "https://public.example.test";
const FUNCTION_HOST = "func.example.test";
const originalAppUrl = process.env["APP_URL"];
const originalWebsiteHostname = process.env["WEBSITE_HOSTNAME"];

function expectPublicAuthLink(
  email: { html?: string; text?: string },
  path: "/verify-email?token=" | "/reset-password?token=",
): void {
  const expectedPrefix = `${PUBLIC_ORIGIN}${path}`;
  expect(email.html).toContain(expectedPrefix);
  expect(email.text).toContain(expectedPrefix);
  expect(email.html).not.toContain(FUNCTION_HOST);
  expect(email.text).not.toContain(FUNCTION_HOST);
}

function restoreEnv(name: "APP_URL" | "WEBSITE_HOSTNAME", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  const a = (ipCounter >> 8) & 0xff;
  const b = ipCounter & 0xff;
  return `198.51.${a}.${b}`;
}

describe("auth flow integration", () => {
  beforeEach(() => {
    process.env["APP_URL"] = PUBLIC_ORIGIN;
    process.env["WEBSITE_HOSTNAME"] = FUNCTION_HOST;
    resetAllBuckets();
    clearSentEmails();
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreEnv("APP_URL", originalAppUrl);
    restoreEnv("WEBSITE_HOSTNAME", originalWebsiteHostname);
  });

  test("(1) register new email + acceptTsCs=true -> 202; one email; T&C persisted", async () => {
    const email = `int-new-${randomUUID()}@example.com`;
    const ip = uniqueIp();

    const res = await invoke("authRegister", {
      method: "POST",
      headers: { "x-forwarded-for": ip },
      body: { email, password: PASSWORD, acceptTsCs: true, acceptedTsCsVersion: 1 },
    });

    expect(res.status).toBe(202);
    const emails = getSentEmails();
    expect(emails).toHaveLength(1);
    expect(emails[0].to).toEqual([email.toLowerCase()]);
    expect(emails[0].subject).toMatch(/Verify/i);

    const index = await readPrivateJson<Record<string, string>>("user-index.json");
    const userId = index![email.toLowerCase()];
    expect(userId).toBeTruthy();
    const stored = await readPrivateJson<Record<string, unknown>>(`users/${userId}.json`);
    expect(stored).toMatchObject({
      acceptedTsCsVersion: 1,
      acceptedTsCsIp: ip,
    });
    expect(typeof stored?.acceptedTsCsAt).toBe("string");
  });

  test("(2) register without acceptTsCs -> 400 TS_CS_NOT_ACCEPTED", async () => {
    const res = await invoke("authRegister", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: { email: `int-no-tcs-${randomUUID()}@example.com`, password: PASSWORD },
    });

    expect(res.status).toBe(400);
    expect(res.jsonBody?.["code"]).toBe("TS_CS_NOT_ACCEPTED");
    expect(getSentEmails()).toHaveLength(0);
  });

  test("(3) register existing verified email -> 202 same shape; zero emails", async () => {
    const { user, credential } = await makeUser({ emailVerified: true });
    await writePrivateJson(`auth/${user.id}.json`, credential);

    const res = await invoke("authRegister", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: {
        email: user.email,
        password: PASSWORD,
        acceptTsCs: true,
        acceptedTsCsVersion: 1,
      },
    });

    expect(res.status).toBe(202);
    expect(res.jsonBody).toMatchObject({ status: "accepted" });
    expect(getSentEmails()).toHaveLength(0);
  });

  test("(4) register existing unverified after >60s -> 202; new verification email re-sent", async () => {
    const { user } = await makeUser({ emailVerified: false });
    const staleToken = `stale-${randomUUID()}`;
    await seedStaleVerificationState(user.id, staleToken, 70_000);

    const res = await invoke("authRegister", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: {
        email: user.email,
        password: PASSWORD,
        acceptTsCs: true,
        acceptedTsCsVersion: 1,
      },
    });

    expect(res.status).toBe(202);
    const emails = getSentEmails();
    expect(emails).toHaveLength(1);
    expect(emails[0].to).toEqual([user.email.toLowerCase()]);

    const newState = await readPrivateJson<VerificationState>(
      verificationStatePath(user.id),
    );
    expect(newState).toBeTruthy();
    expect(newState!.token).not.toBe(staleToken);
    expectPublicAuthLink(emails[0], "/verify-email?token=");
    expect(emails[0].html).toContain(newState!.token);
    expect(emails[0].text).toContain(newState!.token);
  });

  test("resend-verification uses the public origin and remains silent for an unknown address", async () => {
    const { user } = await makeUser({ emailVerified: false });

    const exists = await invoke("authResendVerification", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: { email: user.email },
    });

    expect(exists.status).toBe(200);
    const emails = getSentEmails();
    expect(emails).toHaveLength(1);
    expectPublicAuthLink(emails[0], "/verify-email?token=");

    clearSentEmails();
    const missing = await invoke("authResendVerification", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: { email: `nobody-resend-${randomUUID()}@example.com` },
    });

    expect(missing.status).toBe(200);
    expect(missing.jsonBody).toEqual(exists.jsonBody);
    expect(getSentEmails()).toHaveLength(0);
  });

  test("(5) verify(token) succeeds; verifying again -> 400 INVALID_TOKEN", async () => {
    const { user } = await makeUser({ emailVerified: false });
    const token = await generateShortLivedToken(user.id, "verify", 24);

    const first = await invoke("authVerifyEmail", {
      method: "GET",
      query: { token },
      headers: { "x-forwarded-for": uniqueIp() },
    });
    expect(first.status).toBe(200);

    const cred = await readPrivateJson<AuthCredential>(`auth/${user.id}.json`);
    expect(cred?.emailVerified).toBe(true);

    const second = await invoke("authVerifyEmail", {
      method: "GET",
      query: { token },
      headers: { "x-forwarded-for": uniqueIp() },
    });
    expect(second.status).toBe(400);
    expect(second.jsonBody?.["code"]).toBe("INVALID_TOKEN");
  });

  test("(5a) verify token minted at current tokenVersion succeeds", async () => {
    const { user, credential } = await makeUser({ emailVerified: false });
    await writePrivateJson(`auth/${user.id}.json`, {
      ...credential,
      tokenVersion: 2,
    });
    const token = await generateShortLivedToken(user.id, "verify", 24);

    const res = await invoke("authVerifyEmail", {
      method: "GET",
      query: { token },
      headers: { "x-forwarded-for": uniqueIp() },
    });

    expect(res.status).toBe(200);
    const cred = await readPrivateJson<AuthCredential>(`auth/${user.id}.json`);
    expect(cred?.emailVerified).toBe(true);
    expect(cred?.tokenVersion).toBe(2);
  });

  test("(5b) verify token consumed after tokenVersion bump -> 400 INVALID_TOKEN; email stays unverified", async () => {
    const { user, credential } = await makeUser({ emailVerified: false });
    const state = await readPrivateJson<VerificationState>(
      verificationStatePath(user.id),
    );
    const token = state?.token;
    expect(token).toBeTruthy();
    await writePrivateJson(`auth/${user.id}.json`, {
      ...credential,
      tokenVersion: 1,
    });

    const res = await invoke("authVerifyEmail", {
      method: "GET",
      query: { token: String(token) },
      headers: { "x-forwarded-for": uniqueIp() },
    });

    expect(res.status).toBe(400);
    expect(res.jsonBody?.["code"]).toBe("INVALID_TOKEN");
    const cred = await readPrivateJson<AuthCredential>(`auth/${user.id}.json`);
    expect(cred?.emailVerified).toBe(false);
    expect(cred?.tokenVersion).toBe(1);
    const tokenDoc = await readPrivateJson<AuthToken>(
      `auth/tokens/${sha256Hex(String(token))}.json`,
    );
    expect(tokenDoc?.consumed).toBe(true);
  });

  test("(5c) legacy verify token without tokenVersion works while auth tokenVersion is 0", async () => {
    const { user, credential } = await makeUser({ emailVerified: false });
    await writePrivateJson(`auth/${user.id}.json`, {
      ...credential,
      tokenVersion: 0,
    });
    const token = `legacy-${randomUUID()}`;
    await seedVerifyToken(user.id, token);

    const res = await invoke("authVerifyEmail", {
      method: "GET",
      query: { token },
      headers: { "x-forwarded-for": uniqueIp() },
    });

    expect(res.status).toBe(200);
    const cred = await readPrivateJson<AuthCredential>(`auth/${user.id}.json`);
    expect(cred?.emailVerified).toBe(true);
  });

  test("(6) verify(expired token) -> 400 INVALID_TOKEN; underlying blob untouched", async () => {
    const userId = randomUUID();
    const token = `expired-${randomUUID()}`;
    await seedExpiredVerifyToken(userId, token);

    const res = await invoke("authVerifyEmail", {
      method: "GET",
      query: { token },
      headers: { "x-forwarded-for": uniqueIp() },
    });
    expect(res.status).toBe(400);
    expect(res.jsonBody?.["code"]).toBe("INVALID_TOKEN");

    const tokenDoc = await readPrivateJson<AuthToken>(
      `auth/tokens/${sha256Hex(token)}.json`,
    );
    expect(tokenDoc).toBeTruthy();
    expect(tokenDoc?.consumed).toBeUndefined();
  });

  test("(7) login correct password -> 200 + tokens; failedAttempts reset to 0", async () => {
    const { user } = await makeUser({ emailVerified: true });
    await writePrivateJson(`auth/${user.id}.json`, {
      ...(await readPrivateJson<CredWithLockout>(`auth/${user.id}.json`))!,
      failedAttempts: [new Date(Date.now() - 1000).toISOString()],
      lockedUntil: null,
    });

    const res = await invoke("authLogin", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: { email: user.email, password: PASSWORD },
    });

    expect(res.status).toBe(200);
    expect(res.jsonBody?.["accessToken"]).toEqual(expect.any(String));
    expect(res.jsonBody?.["refreshToken"]).toEqual(expect.any(String));

    const cred = await readPrivateJson<CredWithLockout>(`auth/${user.id}.json`);
    expect(cred?.failedAttempts).toEqual([]);
    expect(cred?.lockedUntil).toBeNull();
  });

  test("(8) login wrong password -> 401; failedAttempts increments; auth.token.reused NOT emitted", async () => {
    const { user } = await makeUser({ emailVerified: true });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const res = await invoke("authLogin", {
        method: "POST",
        headers: { "x-forwarded-for": uniqueIp() },
        body: { email: user.email, password: "WrongPass123!" },
      });

      expect(res.status).toBe(401);

      const cred = await readPrivateJson<CredWithLockout>(`auth/${user.id}.json`);
      expect(cred?.failedAttempts?.length ?? 0).toBe(1);

      const reusedSeen = warnSpy.mock.calls
        .flat()
        .some((c) => String(c).includes("auth.token.reused"));
      expect(reusedSeen).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("(9) 5 wrong then 6th -> 423 ACCOUNT_LOCKED; after >15min clock advance, correct succeeds", async () => {
    const { user } = await makeUser({ emailVerified: true });
    const baseTime = new Date("2026-01-01T12:00:00Z");

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(baseTime);
    const ip = uniqueIp();

    for (let i = 0; i < 5; i++) {
      const res = await invoke("authLogin", {
        method: "POST",
        headers: { "x-forwarded-for": ip },
        body: { email: user.email, password: "WrongPass123!" },
      });
      expect(res.status).toBe(401);
    }

    const locked = await invoke("authLogin", {
      method: "POST",
      headers: { "x-forwarded-for": ip },
      body: { email: user.email, password: "WrongPass123!" },
    });
    expect(locked.status).toBe(423);
    expect(locked.jsonBody?.["code"]).toBe("ACCOUNT_LOCKED");

    const stillLocked = await invoke("authLogin", {
      method: "POST",
      headers: { "x-forwarded-for": ip },
      body: { email: user.email, password: PASSWORD },
    });
    expect(stillLocked.status).toBe(423);

    vi.setSystemTime(new Date(baseTime.getTime() + 16 * 60_000));
    resetAllBuckets();

    const recovered = await invoke("authLogin", {
      method: "POST",
      headers: { "x-forwarded-for": ip },
      body: { email: user.email, password: PASSWORD },
    });
    expect(recovered.status).toBe(200);
  });

  test("(10) refresh(valid token) -> new access token; refresh remains usable", async () => {
    const { user } = await makeUser({ emailVerified: true });

    const login = await invoke("authLogin", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: { email: user.email, password: PASSWORD },
    });
    expect(login.status).toBe(200);
    const refreshToken = String(login.jsonBody?.["refreshToken"]);

    const first = await invoke("authRefresh", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: { refreshToken },
    });
    expect(first.status).toBe(200);
    expect(first.jsonBody?.["accessToken"]).toEqual(expect.any(String));

    const second = await invoke("authRefresh", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: { refreshToken },
    });
    expect(second.status).toBe(200);
    expect(second.jsonBody?.["accessToken"]).toEqual(expect.any(String));
  });

  test("(11) forgot-password silent shape; one email if user exists, zero if not", async () => {
    const { user } = await makeUser({ emailVerified: true });

    const exists = await invoke("authForgotPassword", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: { email: user.email },
    });
    expect(exists.status).toBe(200);
    const emails = getSentEmails();
    expect(emails).toHaveLength(1);
    expectPublicAuthLink(emails[0], "/reset-password?token=");

    clearSentEmails();
    const missing = await invoke("authForgotPassword", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: { email: `nobody-${randomUUID()}@example.com` },
    });
    expect(missing.status).toBe(200);
    expect(missing.jsonBody).toEqual(exists.jsonBody);
    expect(getSentEmails()).toHaveLength(0);
  });

  test("(12) reset-password updates credential; old password no longer works", async () => {
    const { user } = await makeUser({ emailVerified: true });
    const resetToken = await generateShortLivedToken(user.id, "reset", 1);
    const newPassword = "BrandNewPass456!";

    const reset = await invoke("authResetPassword", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: { token: resetToken, newPassword },
    });
    expect(reset.status).toBe(200);

    const oldLogin = await invoke("authLogin", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: { email: user.email, password: PASSWORD },
    });
    expect(oldLogin.status).toBe(401);

    const newLogin = await invoke("authLogin", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: { email: user.email, password: newPassword },
    });
    expect(newLogin.status).toBe(200);
  });

  test("(13) reset-password same token twice in parallel -> exactly 1 success, 1 INVALID_TOKEN", async () => {
    const { user } = await makeUser({ emailVerified: true });
    const resetToken = await generateShortLivedToken(user.id, "reset", 1);

    const [a, b] = await Promise.all([
      invoke("authResetPassword", {
        method: "POST",
        headers: { "x-forwarded-for": uniqueIp() },
        body: { token: resetToken, newPassword: "ParallelOne123!" },
      }),
      invoke("authResetPassword", {
        method: "POST",
        headers: { "x-forwarded-for": uniqueIp() },
        body: { token: resetToken, newPassword: "ParallelTwo123!" },
      }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 400]);
    const failed = [a, b].find((r) => r.status === 400)!;
    expect(failed.jsonBody?.["code"]).toBe("INVALID_TOKEN");
  });

  test("(13a) reset token minted before tokenVersion bump -> 400 INVALID_TOKEN; password unchanged", async () => {
    const { user, credential } = await makeUser({ emailVerified: true });
    const resetToken = await generateShortLivedToken(user.id, "reset", 1);
    await writePrivateJson(`auth/${user.id}.json`, {
      ...credential,
      tokenVersion: 1,
    });

    const res = await invoke("authResetPassword", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: { token: resetToken, newPassword: "ShouldNotApply123!" },
    });

    expect(res.status).toBe(400);
    expect(res.jsonBody?.["code"]).toBe("INVALID_TOKEN");
    const oldLogin = await invoke("authLogin", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: { email: user.email, password: PASSWORD },
    });
    expect(oldLogin.status).toBe(200);
  });

  test("(14) register burst: 4th call from same IP -> 429 RATE_LIMITED + Retry-After header", async () => {
    const ip = uniqueIp();
    resetAllBuckets();

    for (let i = 0; i < 3; i++) {
      const ok = await invoke("authRegister", {
        method: "POST",
        headers: { "x-forwarded-for": ip },
        body: {
          email: `burst-${i}-${randomUUID()}@example.com`,
          password: PASSWORD,
          acceptTsCs: true,
          acceptedTsCsVersion: 1,
        },
      });
      expect(ok.status).toBe(202);
    }

    const fourth = await invoke("authRegister", {
      method: "POST",
      headers: { "x-forwarded-for": ip },
      body: {
        email: `burst-4-${randomUUID()}@example.com`,
        password: PASSWORD,
        acceptTsCs: true,
        acceptedTsCsVersion: 1,
      },
    });

    expect(fourth.status).toBe(429);
    expect(fourth.jsonBody?.["code"]).toBe("RATE_LIMITED");
    expect(fourth.headers?.["Retry-After"]).toBeDefined();
  });

  test("(15) logout bumps tokenVersion and revokes existing refresh tokens", async () => {
    const { user } = await makeUser({ emailVerified: true });
    const login = await invoke("authLogin", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: { email: user.email, password: PASSWORD },
    });
    const accessToken = String(login.jsonBody?.["accessToken"]);
    const refreshToken = String(login.jsonBody?.["refreshToken"]);

    const before = await invoke("authRefresh", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: { refreshToken },
    });
    expect(before.status).toBe(200);

    const out = await invoke("authLogout", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "x-forwarded-for": uniqueIp() },
    });
    expect(out.status).toBe(204);

    const cred = await readPrivateJson<CredWithLockout>(`auth/${user.id}.json`);
    expect(cred?.tokenVersion).toBe(1);

    const after = await invoke("authRefresh", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: { refreshToken },
    });
    expect(after.status).toBe(401);
  });

  test("(16) reset-password revokes previously issued refresh tokens", async () => {
    const { user } = await makeUser({ emailVerified: true });
    const login = await invoke("authLogin", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: { email: user.email, password: PASSWORD },
    });
    const refreshToken = String(login.jsonBody?.["refreshToken"]);

    const before = await invoke("authRefresh", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: { refreshToken },
    });
    expect(before.status).toBe(200);

    const resetToken = await generateShortLivedToken(user.id, "reset", 1);
    const reset = await invoke("authResetPassword", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: { token: resetToken, newPassword: "AfterReset123!" },
    });
    expect(reset.status).toBe(200);

    const after = await invoke("authRefresh", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: { refreshToken },
    });
    expect(after.status).toBe(401);
  });

  test("(17) re-login after logout issues a refresh token usable at the new version", async () => {
    const { user } = await makeUser({ emailVerified: true });
    const first = await invoke("authLogin", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: { email: user.email, password: PASSWORD },
    });
    await invoke("authLogout", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${String(first.jsonBody?.["accessToken"])}`,
        "x-forwarded-for": uniqueIp(),
      },
    });

    const second = await invoke("authLogin", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: { email: user.email, password: PASSWORD },
    });
    const refreshed = await invoke("authRefresh", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: { refreshToken: String(second.jsonBody?.["refreshToken"]) },
    });
    expect(refreshed.status).toBe(200);
  });

  test("(18) logout without a valid access token -> 401", async () => {
    const res = await invoke("authLogout", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
    });
    expect(res.status).toBe(401);
  });

  test("(19) a refresh token without a tokenVersion claim is rejected", async () => {
    const { user } = await makeUser({ emailVerified: true });
    const versionlessToken = jwt.sign(
      { sub: user.id, type: "refresh" },
      process.env["JWT_SECRET"] as string,
      { algorithm: "HS256", expiresIn: "30d" },
    );
    const res = await invoke("authRefresh", {
      method: "POST",
      headers: { "x-forwarded-for": uniqueIp() },
      body: { refreshToken: versionlessToken },
    });
    expect(res.status).toBe(401);
  });
});
