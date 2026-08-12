// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  BriefPdfJob,
  PureTrackGroupJob,
  SignToFlyReflectJob,
} from "../queue.js";

const { sendMessage, QueueClientMock } = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => ({ messageId: "m1" })),
  QueueClientMock: vi.fn(),
}));

// A class (not an arrow fn) because queue.ts constructs QueueClient with `new`.
vi.mock("@azure/storage-queue", () => ({
  QueueClient: class {
    sendMessage = sendMessage;
    constructor(connectionString: string, queueName: string) {
      QueueClientMock(connectionString, queueName);
    }
  },
}));

const QUEUE_CONN = "UseDevelopmentStorage=true;QueueEndpoint=http://127.0.0.1:10001/x;";
const SECOND_QUEUE_CONN = "UseDevelopmentStorage=true;QueueEndpoint=http://127.0.0.1:10001/y;";

describe("enqueueBriefPdf", () => {
  let savedEnv: { queue: string | undefined; blob: string | undefined };

  beforeEach(() => {
    savedEnv = {
      queue: process.env["AzureWebJobsStorage"],
      blob: process.env["BLOB_CONNECTION_STRING"],
    };
    // Reset the module registry so the dynamic import below re-loads queue.js
    // against the mocked @azure/storage-queue (mirrors blob.singleton.test.ts).
    vi.resetModules();
    sendMessage.mockClear();
    QueueClientMock.mockClear();
    process.env["AzureWebJobsStorage"] = QUEUE_CONN;
  });

  afterEach(() => {
    const restore = (key: string, val: string | undefined) => {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    };
    restore("AzureWebJobsStorage", savedEnv.queue);
    restore("BLOB_CONNECTION_STRING", savedEnv.blob);
  });

  test("sends exactly one base64-encoded JSON message in wire key order", async () => {
    const { enqueueBriefPdf } = await import("../queue.js");

    await enqueueBriefPdf({ roundId: "r1", briefVersion: 3, pdfAttemptId: "a1" });

    const expected = Buffer.from(
      '{"roundId":"r1","briefVersion":3,"pdfAttemptId":"a1"}',
    ).toString("base64");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(expected);
  });

  test("builds the QueueClient from AzureWebJobsStorage for the round-brief-pdf queue", async () => {
    const { enqueueBriefPdf, resetQueueSingletons } = await import("../queue.js");

    await enqueueBriefPdf({ roundId: "r1", briefVersion: 3, pdfAttemptId: "a1" });
    expect(QueueClientMock).toHaveBeenCalledTimes(1);
    expect(QueueClientMock).toHaveBeenCalledWith(QUEUE_CONN, "round-brief-pdf");

    // Singleton is reused: a second enqueue does NOT rebuild the client.
    await enqueueBriefPdf({ roundId: "r2", briefVersion: 4, pdfAttemptId: "a2" });
    expect(QueueClientMock).toHaveBeenCalledTimes(1);

    process.env["AzureWebJobsStorage"] = SECOND_QUEUE_CONN;
    resetQueueSingletons();
    await enqueueBriefPdf({ roundId: "r3", briefVersion: 5, pdfAttemptId: "a3" });
    expect(QueueClientMock).toHaveBeenCalledTimes(2);
    expect(QueueClientMock).toHaveBeenLastCalledWith(
      SECOND_QUEUE_CONN,
      "round-brief-pdf",
    );
  });

  test("resets the shared storage-client seam", async () => {
    // Given
    const resetStorageClientSingletons = vi.fn();
    vi.doMock("../storageClients.js", () => ({
      getRuntimeQueueClient: vi.fn(),
      resetStorageClientSingletons,
    }));
    const { resetQueueSingletons } = await import("../queue.js");

    // When
    resetQueueSingletons();

    // Then
    expect(resetStorageClientSingletons).toHaveBeenCalledOnce();
    vi.doUnmock("../storageClients.js");
  });

  test("still targets the round-brief-pdf queue after queue-client caching changes", async () => {
    const { enqueueBriefPdf } = await import("../queue.js");

    await enqueueBriefPdf({ roundId: "r1", briefVersion: 3, pdfAttemptId: "a1" });

    expect(QueueClientMock).toHaveBeenCalledTimes(1);
    expect(QueueClientMock).toHaveBeenCalledWith(QUEUE_CONN, "round-brief-pdf");
  });

  test("requires runtime identity config when AzureWebJobsStorage is unset — no blob fallback", async () => {
    delete process.env["AzureWebJobsStorage"];
    process.env["BLOB_CONNECTION_STRING"] = "UseDevelopmentStorage=true;blob-only;";

    const { enqueueBriefPdf } = await import("../queue.js");

    await expect(
      enqueueBriefPdf({ roundId: "r1", briefVersion: 3, pdfAttemptId: "a1" }),
    ).rejects.toThrow(/RUNTIME_STORAGE_ACCOUNT_NAME/);
    expect(QueueClientMock).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("rejects an extra key at BriefPdfJobSchema.parse (strict → no PII can leak)", async () => {
    const { enqueueBriefPdf } = await import("../queue.js");

    const withExtraKey = {
      roundId: "r1",
      briefVersion: 3,
      pdfAttemptId: "a1",
      recipients: ["x"],
    } as unknown as BriefPdfJob;

    await expect(enqueueBriefPdf(withExtraKey)).rejects.toThrow();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("BriefPdfJobSchema.strict rejects unknown keys", async () => {
    const { BriefPdfJobSchema } = await import("../queue.js");

    expect(() =>
      BriefPdfJobSchema.parse({
        roundId: "r1",
        briefVersion: 3,
        pdfAttemptId: "a1",
        recipients: ["x"],
      }),
    ).toThrow();
    expect(
      BriefPdfJobSchema.parse({ roundId: "r1", briefVersion: 3, pdfAttemptId: "a1" }),
    ).toEqual({ roundId: "r1", briefVersion: 3, pdfAttemptId: "a1" });
  });
});

describe("enqueueSignToFlyReflect", () => {
  let savedEnv: { queue: string | undefined; blob: string | undefined };

  beforeEach(() => {
    savedEnv = {
      queue: process.env["AzureWebJobsStorage"],
      blob: process.env["BLOB_CONNECTION_STRING"],
    };
    vi.resetModules();
    sendMessage.mockClear();
    QueueClientMock.mockClear();
    process.env["AzureWebJobsStorage"] = QUEUE_CONN;
  });

  afterEach(() => {
    const restore = (key: string, val: string | undefined) => {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    };
    restore("AzureWebJobsStorage", savedEnv.queue);
    restore("BLOB_CONNECTION_STRING", savedEnv.blob);
  });

  test("sends exactly one base64-encoded JSON message to the signtofly-reflect queue", async () => {
    const { enqueueSignToFlyReflect } = await import("../queue.js");

    await enqueueSignToFlyReflect({ roundId: "r1" });

    const expected = Buffer.from('{"roundId":"r1"}').toString("base64");
    expect(QueueClientMock).toHaveBeenCalledTimes(1);
    expect(QueueClientMock).toHaveBeenCalledWith(QUEUE_CONN, "signtofly-reflect");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(expected);
  });

  test("rejects an extra key at SignToFlyReflectJobSchema.parse before sending", async () => {
    const { enqueueSignToFlyReflect } = await import("../queue.js");

    const withExtraKey = { roundId: "r1", x: 1 } as unknown as SignToFlyReflectJob;

    await expect(enqueueSignToFlyReflect(withExtraKey)).rejects.toThrow();
    expect(QueueClientMock).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("requires runtime identity config when AzureWebJobsStorage is unset — no blob fallback", async () => {
    delete process.env["AzureWebJobsStorage"];
    process.env["BLOB_CONNECTION_STRING"] = "UseDevelopmentStorage=true;blob-only;";

    const { enqueueSignToFlyReflect } = await import("../queue.js");

    await expect(enqueueSignToFlyReflect({ roundId: "r1" })).rejects.toThrow(
      /RUNTIME_STORAGE_ACCOUNT_NAME/,
    );
    expect(QueueClientMock).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("enqueuePureTrackGroupJob", () => {
  let savedEnv: { queue: string | undefined; blob: string | undefined };

  beforeEach(async () => {
    savedEnv = {
      queue: process.env["AzureWebJobsStorage"],
      blob: process.env["BLOB_CONNECTION_STRING"],
    };
    vi.resetModules();
    sendMessage.mockClear();
    QueueClientMock.mockClear();
    process.env["AzureWebJobsStorage"] = QUEUE_CONN;

    const { resetQueueSingletons } = await import("../queue.js");
    resetQueueSingletons();
  });

  afterEach(() => {
    const restore = (key: string, val: string | undefined) => {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    };
    restore("AzureWebJobsStorage", savedEnv.queue);
    restore("BLOB_CONNECTION_STRING", savedEnv.blob);
  });

  test("sends exactly one base64-encoded job using the shared queue-name-keyed client", async () => {
    const { enqueuePureTrackGroupJob, PURETRACK_GROUP_QUEUE_NAME } = await import(
      "../queue.js"
    );

    await enqueuePureTrackGroupJob({ roundId: "r", attemptId: "a" });

    const expected = Buffer.from('{"roundId":"r","attemptId":"a"}').toString(
      "base64",
    );
    expect(QueueClientMock).toHaveBeenCalledTimes(1);
    expect(QueueClientMock).toHaveBeenCalledWith(
      QUEUE_CONN,
      PURETRACK_GROUP_QUEUE_NAME,
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(expected);
  });

  test("reuses the PureTrack client while keeping other shared queue clients distinct", async () => {
    const { enqueueBriefPdf, enqueuePureTrackGroupJob } = await import("../queue.js");

    await enqueueBriefPdf({ roundId: "r1", briefVersion: 1, pdfAttemptId: "pdf-a" });
    await enqueuePureTrackGroupJob({ roundId: "r1", attemptId: "pt-a" });
    await enqueuePureTrackGroupJob({ roundId: "r2", attemptId: "pt-b" });

    expect(QueueClientMock.mock.calls).toEqual([
      [QUEUE_CONN, "round-brief-pdf"],
      [QUEUE_CONN, "round-puretrack-group"],
    ]);
  });

  test("rejects ownerToken at PureTrackGroupJobSchema.parse before sending", async () => {
    const { enqueuePureTrackGroupJob } = await import("../queue.js");
    const withExtraKey = {
      roundId: "r",
      attemptId: "a",
      ownerToken: "worker-secret",
    } as unknown as PureTrackGroupJob;

    await expect(enqueuePureTrackGroupJob(withExtraKey)).rejects.toThrow();

    expect(QueueClientMock).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("omits sendMessage options when visibility timeout is omitted", async () => {
    const { enqueuePureTrackGroupJob } = await import("../queue.js");

    await enqueuePureTrackGroupJob({ roundId: "r", attemptId: "a" });

    const expected = Buffer.from('{"roundId":"r","attemptId":"a"}').toString(
      "base64",
    );
    expect(sendMessage).toHaveBeenCalledWith(expected);
  });

  test("passes visibilityTimeoutSeconds through to sendMessage", async () => {
    const { enqueuePureTrackGroupJob } = await import("../queue.js");

    await enqueuePureTrackGroupJob(
      { roundId: "r", attemptId: "a" },
      { visibilityTimeoutSeconds: 30 },
    );

    const expected = Buffer.from('{"roundId":"r","attemptId":"a"}').toString(
      "base64",
    );
    expect(sendMessage).toHaveBeenCalledWith(expected, { visibilityTimeout: 30 });
  });

  test.each([-1, 604_801, 1.5])(
    "rejects invalid visibility timeout %s before sending",
    async (visibilityTimeoutSeconds) => {
      const { enqueuePureTrackGroupJob } = await import("../queue.js");

      await expect(
        enqueuePureTrackGroupJob(
          { roundId: "r", attemptId: "a" },
          { visibilityTimeoutSeconds },
        ),
      ).rejects.toThrow();

      expect(QueueClientMock).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
    },
  );
});
