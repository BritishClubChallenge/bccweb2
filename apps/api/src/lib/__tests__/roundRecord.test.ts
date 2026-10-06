// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * Contract test for the round record store (lib/roundRecord.ts, issue #282).
 *
 * Runs against Azurite and pins, per operation: exactly one round readJson
 * (path as the 3rd argument), the read order (round, then the caller's
 * beforeBrief hook, then brief), the write order (brief, then round), the
 * per-operation missing-round semantics, the pass-through of non-404 errors,
 * the lease release on a throwing step, the byte-exact brief restore and the
 * reconcile telemetry when that restore fails.
 *
 * Spy hygiene: every readJson/writePrivateJson spy is created AFTER the
 * fixtures are seeded, and its call arguments are snapshotted immediately
 * after the operation resolves, before any fixture read-back.
 */

import { randomUUID } from "node:crypto";
import { BlockBlobClient } from "@azure/storage-blob";
import { afterEach, describe, expect, test, vi } from "vitest";

import * as blobJson from "../blobJson.js";
import { HttpError } from "../http.js";
import {
  mutateRound,
  mutateRoundRenewing,
  mutateRoundWithBrief,
  mutateRoundWithBriefOrRestore,
  mutateRoundWithPureTrackEchoes,
  readRound,
} from "../roundRecord.js";
import {
  briefFixture,
  bytes,
  readBrief,
  readRound as readRoundBlob,
  roundFixture,
  seed,
  seedRound,
} from "./puretrackStatus.fixtures.js";

const telemetry = vi.hoisted(() => ({
  trackEvent: vi.fn(),
  trackTrace: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => telemetry,
}));

afterEach(() => {
  vi.restoreAllMocks();
  telemetry.trackEvent.mockClear();
});

describe("round record: readRound", () => {
  test("R1 returns the stored round with exactly one read of its blob", async () => {
    const round = roundFixture();
    await seedRound(round);
    const readSpy = vi.spyOn(blobJson, "readJson");

    const result = await readRound(round.id);
    const readPaths = readSpy.mock.calls.map((c) => c[2]);

    expect(result).toEqual(round);
    expect(readPaths).toEqual([`rounds/${round.id}.json`]);
  });

  test("R2 translates a missing round to a 404 NOT_FOUND HttpError", async () => {
    const err = await readRound(randomUUID()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpError);
    const httpErr = err as HttpError;
    expect(httpErr.status).toBe(404);
    expect(httpErr.code).toBe("NOT_FOUND");
    expect(httpErr.detail).toBe("Round not found");
  });

  test("R3 propagates the 400 INVALID_BLOB_PATH rejection for an unsafe id", async () => {
    const err = await readRound("a@b").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpError);
    const httpErr = err as HttpError;
    expect(httpErr.status).toBe(400);
    expect(httpErr.code).toBe("INVALID_BLOB_PATH");
  });

  test("R4 rethrows a non-404 storage failure as the identical object", async () => {
    const round = roundFixture();
    await seedRound(round);
    const boom = Object.assign(new Error("x"), { statusCode: 503 });
    vi.spyOn(blobJson, "readJson").mockRejectedValueOnce(boom);

    await expect(readRound(round.id)).rejects.toBe(boom);
  });
});

describe("round record: mutateRound", () => {
  test("R5 applies the step, persists the round and returns {round, result}", async () => {
    const round = roundFixture();
    await seedRound(round);
    const readSpy = vi.spyOn(blobJson, "readJson");
    let seen: unknown;

    const mutation = await mutateRound(round.id, async (r) => {
      seen = r;
      r.maxTeams = 7;
      return "done";
    });
    const readPaths = readSpy.mock.calls.map((c) => c[2]);

    expect(mutation.result).toBe("done");
    expect(mutation.round).toBe(seen);
    expect(readPaths).toEqual([`rounds/${round.id}.json`]);
    expect((await readRoundBlob(round.id)).maxTeams).toBe(7);
  });

  test("R6 rejects a missing round with 404 NOT_FOUND and never runs the step", async () => {
    const step = vi.fn();

    await expect(mutateRound(randomUUID(), step)).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
    expect(step).not.toHaveBeenCalled();
  });

  test("R7 a throwing step rejects with the identical error and writes nothing", async () => {
    const round = roundFixture();
    await seedRound(round);
    const beforeBytes = await bytes(`rounds/${round.id}.json`);
    const boom = new Error("step boom");

    await expect(
      mutateRound(round.id, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await bytes(`rounds/${round.id}.json`)).toEqual(beforeBytes);

    await expect(
      mutateRound(round.id, async () => {
        throw Object.assign(new Error("y"), { statusCode: 404 });
      }),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await bytes(`rounds/${round.id}.json`)).toEqual(beforeBytes);
  });

  test("R8 releases the lease when the step throws, so the next op succeeds", async () => {
    const round = roundFixture();
    await seedRound(round);
    const boom = new Error("step boom");

    await expect(
      mutateRound(round.id, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    // withPrivateLease never retries acquisition: a leaked lease would 409 here.
    const second = await mutateRound(round.id, async (r) => {
      r.maxTeams = 8;
      return "ok";
    });
    expect(second.result).toBe("ok");
    expect((await readRoundBlob(round.id)).maxTeams).toBe(8);
  });
});

describe("round record: mutateRoundRenewing", () => {
  test("R9 persists and returns {round, result}, and 404s a missing round", async () => {
    const round = roundFixture();
    await seedRound(round);
    let seen: unknown;

    const mutation = await mutateRoundRenewing(round.id, async (r) => {
      seen = r;
      r.maxTeams = 6;
      return "ok";
    });

    expect(mutation.result).toBe("ok");
    expect(mutation.round).toBe(seen);
    expect((await readRoundBlob(round.id)).maxTeams).toBe(6);

    await expect(mutateRoundRenewing(randomUUID(), async () => "never")).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
  });
});

describe("round record: mutateRoundWithBrief", () => {
  test("R10 reads round-then-brief, writes brief-then-round and persists both edits", async () => {
    const round = roundFixture();
    const brief = briefFixture(round);
    await seed(round, brief);
    const readSpy = vi.spyOn(blobJson, "readJson");
    const writeSpy = vi.spyOn(blobJson, "writePrivateJson");
    const order: string[] = [];

    const mutation = await mutateRoundWithBrief(round.id, {
      beforeBrief: (r) => {
        order.push("beforeBrief");
        expect(r.maxTeams).toBe(round.maxTeams);
      },
      mutate: async ({ round: r, brief: b }) => {
        order.push("mutate");
        r.maxTeams = 11;
        b.briefingTime = "10:45";
        return "done";
      },
    });
    const readPaths = readSpy.mock.calls.map((c) => c[2]);
    const writePaths = writeSpy.mock.calls.map((c) => c[0]);

    expect(readPaths).toEqual([`rounds/${round.id}.json`, `round-briefs/${round.id}.json`]);
    expect(writePaths).toEqual([`round-briefs/${round.id}.json`, `rounds/${round.id}.json`]);
    expect(order).toEqual(["beforeBrief", "mutate"]);
    expect(mutation.result).toBe("done");
    expect(mutation.round.maxTeams).toBe(11);
    expect((await readRoundBlob(round.id)).maxTeams).toBe(11);
    expect((await readBrief(round.id)).briefingTime).toBe("10:45");
  });

  test("R10 aborts before the brief read when beforeBrief throws, writing nothing", async () => {
    const round = roundFixture();
    const brief = briefFixture(round);
    await seed(round, brief);
    const readSpy = vi.spyOn(blobJson, "readJson");
    const writeSpy = vi.spyOn(blobJson, "writePrivateJson");
    const boom = new Error("beforeBrief boom");

    await expect(
      mutateRoundWithBrief(round.id, {
        beforeBrief: () => {
          throw boom;
        },
        mutate: async () => "never",
      }),
    ).rejects.toBe(boom);
    const readPaths = readSpy.mock.calls.map((c) => c[2]);
    const writePaths = writeSpy.mock.calls.map((c) => c[0]);

    expect(readPaths).toEqual([`rounds/${round.id}.json`]);
    expect(writePaths).toEqual([]);
    expect(await bytes(`rounds/${round.id}.json`)).toEqual(
      Buffer.from(JSON.stringify(round, null, 2)),
    );
    expect(await bytes(`round-briefs/${round.id}.json`)).toEqual(
      Buffer.from(JSON.stringify(brief, null, 2)),
    );
  });

  test("R11 rejects a missing round with 404 NOT_FOUND", async () => {
    await expect(
      mutateRoundWithBrief(randomUUID(), {
        beforeBrief: () => undefined,
        mutate: async () => "never",
      }),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });
});

describe("round record: mutateRoundWithBriefOrRestore", () => {
  test("R12(a) writes brief-then-round and returns {round, result} on success", async () => {
    const round = roundFixture();
    const brief = briefFixture(round);
    await seed(round, brief);
    const readSpy = vi.spyOn(blobJson, "readJson");
    const writeSpy = vi.spyOn(blobJson, "writePrivateJson");

    const mutation = await mutateRoundWithBriefOrRestore(round.id, "lock", {
      beforeBrief: () => undefined,
      mutate: async ({ round: r, brief: b }) => {
        r.maxTeams = 12;
        b.briefingTime = "11:15";
        return "done";
      },
    });
    const readPaths = readSpy.mock.calls.map((c) => c[2]);
    const writePaths = writeSpy.mock.calls.map((c) => c[0]);

    expect(readPaths).toEqual([`rounds/${round.id}.json`, `round-briefs/${round.id}.json`]);
    expect(writePaths).toEqual([`round-briefs/${round.id}.json`, `rounds/${round.id}.json`]);
    expect(mutation.result).toBe("done");
    expect(mutation.round.maxTeams).toBe(12);
    expect((await readRoundBlob(round.id)).maxTeams).toBe(12);
    expect((await readBrief(round.id)).briefingTime).toBe("11:15");
  });

  test("R12(b) restores the brief byte-exactly when the round write fails", async () => {
    const round = roundFixture();
    const brief = briefFixture(round);
    await seed(round, brief);
    const beforeBrief = await bytes(`round-briefs/${round.id}.json`);
    const originalWrite = blobJson.writePrivateJson;
    vi.spyOn(blobJson, "writePrivateJson").mockImplementation(
      async (path, schema, data, leaseId, opts) => {
        if (path === `rounds/${round.id}.json`) throw new Error("injected round write failure");
        return originalWrite(path, schema, data, leaseId, opts);
      },
    );

    await expect(
      mutateRoundWithBriefOrRestore(round.id, "lock", {
        beforeBrief: () => undefined,
        mutate: async ({ round: r, brief: b }) => {
          r.maxTeams = 13;
          b.briefingTime = "12:00";
          return "never";
        },
      }),
    ).rejects.toThrow("injected round write failure");

    expect(await bytes(`round-briefs/${round.id}.json`)).toEqual(beforeBrief);
    expect(await readRoundBlob(round.id)).toEqual(round);
    expect(telemetry.trackEvent).not.toHaveBeenCalled();
  });

  test("R12(c) emits reconcile telemetry when the brief restore itself fails", async () => {
    const round = roundFixture();
    const brief = briefFixture(round);
    await seed(round, brief);
    const id = round.id;
    const originalWrite = blobJson.writePrivateJson;
    vi.spyOn(blobJson, "writePrivateJson").mockImplementation(
      async (path, schema, data, leaseId, opts) => {
        if (path === `rounds/${id}.json`) throw new Error("injected round write failure");
        return originalWrite(path, schema, data, leaseId, opts);
      },
    );
    const originalUpload = BlockBlobClient.prototype.upload;
    let briefUploads = 0;
    vi.spyOn(BlockBlobClient.prototype, "upload").mockImplementation(function (
      this: BlockBlobClient,
      data,
      length,
      options,
    ) {
      if (
        this.url.includes(`round-briefs/${id}.json`) &&
        options?.conditions?.leaseId !== undefined
      ) {
        briefUploads += 1;
        if (briefUploads === 2) return Promise.reject(new Error("injected rollback failure"));
      }
      return originalUpload.call(this, data, length, options);
    });

    await expect(
      mutateRoundWithBriefOrRestore(id, "lock", {
        beforeBrief: () => undefined,
        mutate: async ({ round: r, brief: b }) => {
          r.maxTeams = 14;
          b.briefingTime = "12:30";
          return "never";
        },
      }),
    ).rejects.toThrow("injected round write failure");

    expect(telemetry.trackEvent).toHaveBeenCalledTimes(1);
    expect(telemetry.trackEvent).toHaveBeenCalledWith({
      name: "puretrack.crossBlobReconcileRequired",
      properties: {
        roundId: id,
        operation: "lock",
        roundWriteError: "Error",
        rollbackError: "Error",
      },
    });
  });

  test("R12(d) propagates a missing round as the raw storage 404, not an HttpError", async () => {
    const err = await mutateRoundWithBriefOrRestore(randomUUID(), "lock", {
      beforeBrief: () => undefined,
      mutate: async () => "never",
    }).catch((e: unknown) => e);

    expect(err).not.toBeInstanceOf(HttpError);
    expect((err as { statusCode?: number }).statusCode).toBe(404);
  });
});

describe("round record: mutateRoundWithPureTrackEchoes", () => {
  test("R13 persists through the delegated lifecycle and returns {round, result}", async () => {
    const round = roundFixture();
    await seed(round, briefFixture(round));

    const mutation = await mutateRoundWithPureTrackEchoes(round.id, async ({ round: r }) => {
      r.maxTeams = 9;
      return "ok";
    });

    expect(mutation.result).toBe("ok");
    expect(mutation.round.maxTeams).toBe(9);
    const persisted = await readRoundBlob(round.id);
    expect(persisted.maxTeams).toBe(9);
    expect(persisted).toEqual(mutation.round);
  });

  test("R13 propagates a round write failure untouched, never as an HttpError", async () => {
    const round = roundFixture();
    await seed(round, briefFixture(round));
    const originalWrite = blobJson.writePrivateJson;
    vi.spyOn(blobJson, "writePrivateJson").mockImplementation(
      async (path, schema, data, leaseId, opts) => {
        if (path === `rounds/${round.id}.json`) throw new Error("injected round write failure");
        return originalWrite(path, schema, data, leaseId, opts);
      },
    );

    const err = await mutateRoundWithPureTrackEchoes(round.id, async ({ round: r }) => {
      r.maxTeams = 9;
      return "ok";
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("injected round write failure");
    expect(err).not.toBeInstanceOf(HttpError);
  });
});
