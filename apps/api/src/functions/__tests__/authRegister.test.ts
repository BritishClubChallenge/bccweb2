// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import crypto from "crypto";
import { afterEach, describe, expect, test, vi, beforeEach } from "vitest";
import type { User } from "@bccweb/types";
import { getRegisteredHandler, getSentEmails } from "../../__tests__/helpers/setup.js";
import { makeRequest } from "../../__tests__/helpers/api.js";
import { getPrivateContainer } from "../../__tests__/helpers/azurite.js";
import { makeUser, privateBlobExists, readPrivateJson, writePrivateJson } from "../../__tests__/helpers/seed.js";
import { sendEmail } from "../../lib/email.js";
import { lookupUserByEmail, type AuthCredential } from "../../lib/authHelpers.js";
import "../authFunctions.js";

vi.mock("../../lib/authHelpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/authHelpers.js")>();
  return {
    ...actual,
    lookupUserByEmail: vi.fn(actual.lookupUserByEmail),
  };
});

const registerResponse = {
  status: "accepted",
  message:
    "If this email is not yet registered, you will receive a verification link shortly.",
};

const PUBLIC_ORIGIN = "https://public.example.test";
const FUNCTION_HOST = "func.example.test";
const originalAppUrl = process.env["APP_URL"];
const originalWebsiteHostname = process.env["WEBSITE_HOSTNAME"];

function expectPublicVerificationLink(email: { html?: string; text?: string }): void {
  const expectedPrefix = `${PUBLIC_ORIGIN}/verify-email?token=`;
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

function verificationStatePath(userId: string): string {
  return `auth/verification-state/${userId}.json`;
}

function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function seedFreshVerificationState(userId: string, token = "fresh-verification-token") {
  const createdAt = new Date().toISOString();
  await writePrivateJson(verificationStatePath(userId), {
    token,
    createdAt,
    expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
  });
  await writePrivateJson(`auth/tokens/${tokenHash(token)}.json`, {
    userId,
    type: "verify",
    createdAt,
    expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
  });
}

async function listPrivateBlobNames(prefix: string): Promise<string[]> {
  const names: string[] = [];
  for await (const blob of getPrivateContainer().listBlobsFlat({ prefix })) {
    names.push(blob.name);
  }
  return names.sort();
}

describe("auth register enumeration neutralization", () => {
  beforeEach(() => {
    process.env["APP_URL"] = PUBLIC_ORIGIN;
    process.env["WEBSITE_HOSTNAME"] = FUNCTION_HOST;
    vi.mocked(sendEmail).mockClear();
    vi.mocked(lookupUserByEmail).mockClear();
  });

  afterEach(() => {
    restoreEnv("APP_URL", originalAppUrl);
    restoreEnv("WEBSITE_HOSTNAME", originalWebsiteHostname);
  });

  test("register with new email: 202 + verification email sent", async () => {
    const entry = getRegisteredHandler("authRegister");
    expect(entry).toBeTruthy();

    const email = `new-${Date.now()}@example.com`;
    const req = makeRequest({
      method: "POST",
      body: { email, password: "TestPass123!", acceptTsCs: true, acceptedTsCsVersion: 1 },
    });

    const res = await entry!.handler(req, { log: () => undefined });

    expect(res.status).toBe(202);
    expect(res.jsonBody).toEqual(registerResponse);
    expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(1);
    expectPublicVerificationLink(getSentEmails()[0]);

    const userIndex = await readPrivateJson<Record<string, string>>("user-index.json");
    const userId = userIndex?.[email.toLowerCase()];
    expect(userId).toBeTruthy();
    await expect(privateBlobExists(`users/${userId}.json`)).resolves.toBe(true);
    await expect(privateBlobExists(`auth/${userId}.json`)).resolves.toBe(true);
  });

  test("register index-claim conflict: 202 same body + loser auth/user blobs GC'd", async () => {
    const entry = getRegisteredHandler("authRegister");
    expect(entry).toBeTruthy();

    const ownerId = `owner-${crypto.randomUUID()}`;
    const email = `claim-conflict-${crypto.randomUUID()}@example.com`;
    const emailLower = email.toLowerCase();
    const createdAt = new Date().toISOString();
    const owner: User = {
      id: ownerId,
      email: emailLower,
      roles: [],
      pilotId: null,
      clubId: null,
      createdAt,
    };
    const credential: AuthCredential = {
      passwordHash: "existing-password-hash-not-used",
      emailVerified: false,
      createdAt,
    };
    await writePrivateJson("user-index.json", { [emailLower]: ownerId });
    await writePrivateJson(`users/${ownerId}.json`, owner);
    await writePrivateJson(`auth/${ownerId}.json`, credential);
    const usersBeforeRegister = await listPrivateBlobNames("users/");
    const authCredentialsBeforeRegister = (await listPrivateBlobNames("auth/"))
      .filter((name) => /^auth\/[^/]+\.json$/.test(name));
    vi.mocked(lookupUserByEmail).mockResolvedValueOnce(null);

    const res = await entry!.handler(
      makeRequest({
        method: "POST",
        body: { email, password: "TestPass123!", acceptTsCs: true, acceptedTsCsVersion: 1 },
      }),
      { log: () => undefined },
    );

    expect(res.status).toBe(202);
    expect(res.jsonBody).toEqual(registerResponse);
    expect(JSON.stringify(res.jsonBody)).not.toContain("EMAIL_TAKEN");
    expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(1);

    const userIndex = await readPrivateJson<Record<string, string>>("user-index.json");
    expect(userIndex?.[emailLower]).toBe(ownerId);
    await expect(listPrivateBlobNames("users/")).resolves.toEqual(usersBeforeRegister);
    const authCredentialBlobs = (await listPrivateBlobNames("auth/"))
      .filter((name) => /^auth\/[^/]+\.json$/.test(name));
    expect(authCredentialBlobs).toEqual(authCredentialsBeforeRegister);
  });

  test("register with existing unverified email: 202 + email re-sent", async () => {
    const { user } = await makeUser({ emailVerified: false });
    await seedFreshVerificationState(user.id);

    const entry = getRegisteredHandler("authRegister");
    expect(entry).toBeTruthy();

    const req = makeRequest({
      method: "POST",
      body: { email: user.email, password: "TestPass123!", acceptTsCs: true, acceptedTsCsVersion: 1 },
    });

    const res = await entry!.handler(req, { log: () => undefined });

    expect(res.status).toBe(202);
    expect(res.jsonBody).toEqual(registerResponse);
    expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(1);
    const sentEmail = getSentEmails()[0];
    expectPublicVerificationLink(sentEmail);
    expect(sentEmail.html).toContain("fresh-verification-token");
    expect(sentEmail.text).toContain("fresh-verification-token");
  });

  test("register with existing verified email: 202 + zero emails sent", async () => {
    const { user, credential } = await makeUser({ emailVerified: true });
    await writePrivateJson(`auth/${user.id}.json`, credential);

    const entry = getRegisteredHandler("authRegister");
    expect(entry).toBeTruthy();

    const req = makeRequest({
      method: "POST",
      body: { email: user.email, password: "TestPass123!", acceptTsCs: true, acceptedTsCsVersion: 1 },
    });

    const res = await entry!.handler(req, { log: () => undefined });

    expect(res.status).toBe(202);
    expect(res.jsonBody).toEqual(registerResponse);
    expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(0);
  });

  test("register response body identical across all three branches", async () => {
    const entry = getRegisteredHandler("authRegister");
    expect(entry).toBeTruthy();

    const newEmail = `shape-new-${Date.now()}@example.com`;
    const { user: unverifiedUser } = await makeUser({ emailVerified: false });
    await seedFreshVerificationState(unverifiedUser.id, "fresh-token-shape");
    const { user: verifiedUser } = await makeUser({ emailVerified: true });

    const responses = [] as unknown[];

    responses.push(
      (await entry!.handler(
        makeRequest({ method: "POST", body: { email: newEmail, password: "TestPass123!", acceptTsCs: true, acceptedTsCsVersion: 1 } }),
        { log: () => undefined },
      )).jsonBody,
    );
    responses.push(
      (await entry!.handler(
        makeRequest({ method: "POST", body: { email: unverifiedUser.email, password: "TestPass123!", acceptTsCs: true, acceptedTsCsVersion: 1 } }),
        { log: () => undefined },
      )).jsonBody,
    );
    responses.push(
      (await entry!.handler(
        makeRequest({ method: "POST", body: { email: verifiedUser.email, password: "TestPass123!", acceptTsCs: true, acceptedTsCsVersion: 1 } }),
        { log: () => undefined },
      )).jsonBody,
    );

    expect(responses[0]).toEqual(responses[1]);
    expect(responses[1]).toEqual(responses[2]);
  });
});
