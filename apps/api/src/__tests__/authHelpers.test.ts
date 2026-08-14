// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { afterEach, describe, test, expect } from "vitest";
import crypto from "crypto";
import {
  generateShortLivedToken,
  consumeShortLivedToken,
  getAppUrl,
  TokenNotFoundError,
  TokenExpiredError,
  TokenAlreadyConsumedError,
} from "../lib/authHelpers.js";
import type { AuthToken } from "../lib/authHelpers.js";
import { getPrivateContainer } from "./helpers/azurite.js";
import { writePrivateJson } from "./helpers/seed.js";

const originalAppUrl = process.env["APP_URL"];
const originalWebsiteHostname = process.env["WEBSITE_HOSTNAME"];

function restoreEnv(name: "APP_URL" | "WEBSITE_HOSTNAME", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  restoreEnv("APP_URL", originalAppUrl);
  restoreEnv("WEBSITE_HOSTNAME", originalWebsiteHostname);
});

describe("getAppUrl", () => {
  test.each(["https://x.example.test", "https://x.example.test/"])(
    "APP_URL %s wins and produces one slash before an auth path",
    (appUrl) => {
      process.env["APP_URL"] = appUrl;
      process.env["WEBSITE_HOSTNAME"] = "func.example.test";

      expect(getAppUrl()).toBe("https://x.example.test");
      expect(`${getAppUrl()}/verify-email?token=sentinel`).toBe(
        "https://x.example.test/verify-email?token=sentinel",
      );
    },
  );

  test("WEBSITE_HOSTNAME is prefixed with https when APP_URL is unset", () => {
    delete process.env["APP_URL"];
    process.env["WEBSITE_HOSTNAME"] = "func.example.test";

    expect(getAppUrl()).toBe("https://func.example.test");
  });

  test("localhost Vite origin is used when neither deployment setting exists", () => {
    delete process.env["APP_URL"];
    delete process.env["WEBSITE_HOSTNAME"];

    expect(getAppUrl()).toBe("http://localhost:5173");
  });
});

async function seedAuthCredential(userId: string, tokenVersion = 0): Promise<void> {
  await writePrivateJson(`auth/${userId}.json`, {
    passwordHash: "hash",
    emailVerified: false,
    createdAt: new Date().toISOString(),
    tokenVersion,
  });
}

describe("consumeShortLivedToken", () => {
  test("happy: first consume returns userId, second consume throws TokenAlreadyConsumedError", async () => {
    const userId = crypto.randomUUID();
    await seedAuthCredential(userId, 3);
    const raw = await generateShortLivedToken(userId, "verify", 24);

    const result = await consumeShortLivedToken(raw, "verify");
    expect(result).toEqual({ userId, tokenVersion: 3 });

    await expect(consumeShortLivedToken(raw, "verify")).rejects.toBeInstanceOf(
      TokenAlreadyConsumedError
    );
  });

  test("expired token throws TokenExpiredError without deleting blob", async () => {
    const userId = crypto.randomUUID();
    const raw = crypto.randomBytes(32).toString("hex");
    const hash = crypto.createHash("sha256").update(raw).digest("hex");

    const tokenDoc: AuthToken = {
      userId,
      type: "verify",
      expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
    };

    const blobClient = getPrivateContainer().getBlockBlobClient(`auth/tokens/${hash}.json`);
    const content = JSON.stringify(tokenDoc);
    await blobClient.upload(content, Buffer.byteLength(content), {
      blobHTTPHeaders: { blobContentType: "application/json" },
    });

    await expect(consumeShortLivedToken(raw, "verify")).rejects.toBeInstanceOf(
      TokenExpiredError
    );

    expect(await blobClient.exists()).toBe(true);
  });

  test("missing token throws TokenNotFoundError", async () => {
    const raw = crypto.randomBytes(32).toString("hex");

    await expect(consumeShortLivedToken(raw, "verify")).rejects.toBeInstanceOf(
      TokenNotFoundError
    );
  });

  test("concurrent: 10 parallel consumes -> exactly 1 succeeds, 9 throw TokenAlreadyConsumedError", async () => {
    const userId = crypto.randomUUID();
    await seedAuthCredential(userId);
    const raw = await generateShortLivedToken(userId, "verify", 24);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => consumeShortLivedToken(raw, "verify"))
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(
      (fulfilled[0] as PromiseFulfilledResult<{ userId: string; tokenVersion: number }>).value
    ).toEqual({ userId, tokenVersion: 0 });

    expect(rejected).toHaveLength(9);
    for (const r of rejected) {
      expect((r).reason).toBeInstanceOf(
        TokenAlreadyConsumedError
      );
    }
  });
});
