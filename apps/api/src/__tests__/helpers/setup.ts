// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * Setup file for API integration tests.
 *
 * - Sets environment variables needed by the app code
 * - Mocks @azure/functions to capture handler registrations
 * - Mocks external services (email, pdf, puretrack) to prevent real calls
 */

process.env["NODE_ENV"] ??= "test";
process.env["TEST_BCRYPT_COST"] ??= "4";

const { beforeAll, beforeEach, vi } = await import("vitest");
const { resetAllBuckets } = await import("../../lib/rateLimit.js");

// ─── Environment variables ────────────────────────────────────────────────────

const AZURITE_CONNECTION_STRING =
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;" +
  "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;" +
  "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";

// Queue-capable sibling of AZURITE_CONNECTION_STRING (blob-only) — carries a
// QueueEndpoint so the brief-PDF producer (lib/queue.ts) can resolve its queue
// endpoint from AzureWebJobsStorage in tests. Azurite queue service is on :10001.
const AZURITE_QUEUE_CONNECTION_STRING =
  AZURITE_CONNECTION_STRING +
  "QueueEndpoint=http://127.0.0.1:10001/devstoreaccount1;";

process.env["BLOB_CONNECTION_STRING"] ??= AZURITE_CONNECTION_STRING;
process.env["AzureWebJobsStorage"] ??= AZURITE_QUEUE_CONNECTION_STRING;
process.env["JWT_SECRET"] ??= "test-jwt-secret-for-vitest-at-least-32-chars-long";
process.env["APP_URL"] ??= "http://localhost:5173";

// Per-file reset of lib/queue.ts's QueueClient (mirrors resetBlobSingletons).
// Import stays lazy INSIDE the hook: a top-level import would load lib/queue.js
// before queue.test.ts's vi.mock("@azure/storage-queue") registers, poisoning it.
beforeAll(async () => {
  const { resetQueueSingletons } = await import("../../lib/queue.js");
  resetQueueSingletons();
});

// ─── Mock @azure/functions ────────────────────────────────────────────────────

// Handler registry — captured via the mocked app.http()
const _handlers = new Map<
  string,
  { methods: string[]; route: string; handler: Function }
>();

// Queue-trigger registry — captured via the mocked app.storageQueue()
const _queueHandlers = new Map<
  string,
  { queueName: string; handler: Function }
>();

vi.mock("@azure/functions", () => ({
  app: {
    http: vi.fn(
      (
        name: string,
        options: {
          methods: string[];
          authLevel: string;
          route: string;
          handler: Function;
        },
      ) => {
        _handlers.set(name, {
          methods: options.methods,
          route: options.route,
          handler: options.handler,
        });
      },
    ),
    storageQueue: vi.fn(
      (
        name: string,
        options: { queueName: string; connection?: string; handler: Function },
      ) => {
        _queueHandlers.set(name, {
          queueName: options.queueName,
          handler: options.handler,
        });
      },
    ),
  },
}));

// Export the handler registry so tests can invoke handlers
export function getRegisteredHandler(name: string) {
  return _handlers.get(name);
}

export function getRegisteredHandlers() {
  return _handlers;
}

export function getRegisteredQueueHandler(name: string) {
  const entry = _queueHandlers.get(name);
  if (!entry) {
    throw new Error(
      `Queue handler "${name}" not registered. Did you import the function module?`,
    );
  }
  return entry;
}

export function getRegisteredQueueHandlers() {
  return _queueHandlers;
}

// ─── Mock external services ───────────────────────────────────────────────────

// Mock email module — prevent real ACS email calls
vi.mock("../../lib/email.js", () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  briefHtmlBody: vi.fn((siteName: string, dateDisplay: string) => `<p>${siteName} ${dateDisplay}</p>`),
  briefPlainText: vi.fn((siteName: string, dateDisplay: string) => `${siteName} ${dateDisplay}`),
  verificationEmailHtml: vi.fn((url: string) => `<p>verify ${url}</p>`),
  verificationEmailText: vi.fn((url: string) => `verify ${url}`),
  passwordResetEmailHtml: vi.fn((url: string) => `<p>reset ${url}</p>`),
  passwordResetEmailText: vi.fn((url: string) => `reset ${url}`),
}));

// ─── Email mock helpers ───────────────────────────────────────────────────────
//
// vi.mock above is hoisted by Vitest above this static import, so the `sendEmail`
// imported here is the mocked function. Do NOT reorder.

const { sendEmail } = await import("../../lib/email.js");

export interface CapturedEmail {
  to: string[];
  subject: string;
  html?: string;
  text?: string;
}

export function getSentEmails(): CapturedEmail[] {
  const calls = vi.mocked(sendEmail).mock.calls as Array<[CapturedEmail]>;
  return calls.map(([opts]) => opts);
}

export function getLastVerificationUrl(): string | null {
  for (const email of getSentEmails().toReversed()) {
    const content = `${email.html ?? ""}\n${email.text ?? ""}`;
    const match = content.match(/https?:\/\/\S+\/verify-email\?token=[^\s<"]+/);
    if (match) return match[0];
  }
  return null;
}

export function clearSentEmails(): void {
  vi.mocked(sendEmail).mockClear();
}

beforeEach(() => resetAllBuckets());
