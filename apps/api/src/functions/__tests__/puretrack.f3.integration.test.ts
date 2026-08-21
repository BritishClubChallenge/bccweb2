// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
// allow: SIZE_OK — one Vitest module registry is required for the cumulative F3 wire log.
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { BriefSchema, RoundSchema } from "@bccweb/schemas";
import type { PureTrackGroupJob } from "../../lib/queue.js";
import type { Round, RoundBrief, User } from "@bccweb/types";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queueMock = vi.hoisted(() => ({
  brief: vi.fn(),
  pureTrack: vi.fn(),
  reflect: vi.fn(),
}));
vi.mock("../../lib/queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queue.js")>()),
  enqueueBriefPdf: queueMock.brief,
  enqueuePureTrackGroupJob: queueMock.pureTrack,
  enqueueSignToFlyReflect: queueMock.reflect,
}));

const telemetryMock = vi.hoisted(() => {
  const trackEvent = vi.fn();
  const target: Record<string | symbol, unknown> = { trackEvent };
  return {
    trackEvent,
    client: new Proxy(target, {
      get(record, property) {
        if (property in record) return record[property];
        const stub = vi.fn();
        record[property] = stub;
        return stub;
      },
    }),
  };
});
vi.mock("../../lib/telemetry.js", () => ({
  getTelemetryClient: () => telemetryMock.client,
  resetForTests: vi.fn(),
  setup: vi.fn(),
}));

const blobWriteControl = vi.hoisted(() => ({ roundPath: "", remaining: 0 }));
vi.mock("../../lib/blobJson.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/blobJson.js")>();
  return {
    ...actual,
    writePrivateJson: vi.fn(async (blobPath, schema, data, leaseId, options) => {
      if (blobPath === blobWriteControl.roundPath && blobWriteControl.remaining > 0) {
        blobWriteControl.remaining -= 1;
        throw new Error("F3 injected round write failure");
      }
      return actual.writePrivateJson(blobPath, schema, data, leaseId, options);
    }),
  };
});

import { invoke, invokeQueue, makeAuthRequest } from "../../__tests__/helpers/api.js";
import { getPrivateContainer } from "../../__tests__/helpers/azurite.js";
import {
  makePilot,
  makeUser,
  privateBlobExists,
  readPrivateJson,
  writePrivateJson,
} from "../../__tests__/helpers/seed.js";
import {
  acquirePureTrackMutationGuard,
  releasePureTrackGuard,
} from "../../lib/puretrackGuard.js";
import { PureTrackGroupJobSchema } from "../../lib/queue.js";
import { computeBriefHash } from "../../lib/signTofly/briefVersion.js";
import { writeSignature } from "../../lib/signTofly/ledger.js";
import "../puretrack.js";
import "../puretrackGroups.js";
import "../rounds.js";
import "../roundsMutate.js";

type WireEntry = {
  readonly scenario: string;
  readonly sequence: number;
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
  readonly status: number;
  readonly injectedFailure?: string;
};

type UpstreamGroup = { readonly id: number; readonly name: string; readonly slug: string };

type Fixture = {
  readonly admin: User;
  readonly roundId: string;
  readonly teamId: string;
  readonly pilotId: string;
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE_ROOT = path.resolve(HERE, "..", "..", "..", "..", "..");
const EVIDENCE_DIR = path.resolve(WORKTREE_ROOT, "..", "..", ".omo", "evidence");
const REQUEST_LOG_PATH = path.join(EVIDENCE_DIR, "f3-puretrack-mock-requests.json");

function parseBody(body: unknown): unknown {
  if (typeof body !== "string") return null;
  return JSON.parse(body);
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function groupName(body: unknown): string {
  if (typeof body !== "object" || body === null || !("name" in body)) {
    throw new Error("PureTrack create request omitted name");
  }
  if (typeof body.name !== "string" || body.name.length === 0) {
    throw new Error("PureTrack create request name was invalid");
  }
  return body.name;
}

class DeterministicPureTrack {
  readonly log: WireEntry[] = [];
  readonly groups = new Map<number, UpstreamGroup>();
  scenario = "unassigned";
  nextId = 100;
  malformedCreate = false;
  failImport = false;
  onImport: ((groupId: number) => void) | undefined;

  reset(scenario: string): void {
    this.scenario = scenario;
    this.groups.clear();
    this.nextId = 100;
    this.malformedCreate = false;
    this.failImport = false;
    this.onImport = undefined;
  }

  seed(groups: readonly UpstreamGroup[]): void {
    for (const group of groups) this.groups.set(group.id, group);
  }

  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = requestUrl(input);
    const method = init?.method ?? "GET";
    const body = parseBody(init?.body);
    let response: Response;
    let injectedFailure: string | undefined;

    if (url.endsWith("/api/login") && method === "POST") {
      response = Response.json({ access_token: "f3-token" });
    } else if (url.endsWith("/login") && method === "GET") {
      response = new Response('<meta name="csrf-token" content="f3-csrf">');
    } else if (url.endsWith("/api/groups?mine=1") && method === "GET") {
      response = Response.json({ data: [...this.groups.values()] });
    } else if (url.endsWith("/api/groups") && method === "POST") {
      const name = groupName(body);
      const id = this.nextId;
      this.nextId += 1;
      const group = { id, name, slug: `f3-group-${id}` } satisfies UpstreamGroup;
      this.groups.set(id, group);
      if (this.malformedCreate) {
        this.malformedCreate = false;
        injectedFailure = "malformed-create-response";
        response = Response.json({ id, name });
      } else {
        response = Response.json(group);
      }
    } else {
      const importMatch = url.match(/\/api\/groups\/(\d+)\/import-ids$/);
      const deleteMatch = url.match(/\/api\/groups\/(\d+)$/);
      if (importMatch !== null && method === "POST") {
        const groupId = Number(importMatch[1]);
        this.onImport?.(groupId);
        if (this.failImport) {
          this.failImport = false;
          injectedFailure = "import-500";
          response = new Response("injected import failure", { status: 500 });
        } else {
          response = new Response(null, { status: 204 });
        }
      } else if (deleteMatch !== null && method === "DELETE") {
        const id = Number(deleteMatch[1]);
        const status = this.groups.delete(id) ? 204 : 404;
        response = new Response(null, { status });
      } else {
        throw new Error(`Unexpected PureTrack request: ${method} ${url}`);
      }
    }

    this.log.push({
      scenario: this.scenario,
      sequence: this.log.length + 1,
      method,
      url,
      body,
      status: response.status,
      ...(injectedFailure === undefined ? {} : { injectedFailure }),
    });
    return response;
  }
}

const upstream = new DeterministicPureTrack();
vi.stubGlobal("fetch", upstream.fetch.bind(upstream));

function slot(pilotId: string): Round["teams"][number]["pilots"][number] {
  return {
    placeInTeam: 1,
    isScoring: true,
    status: "Filled",
    accountedFor: false,
    signToFly: false,
    noScore: false,
    pilotPoints: 0,
    pilotId,
    snapshot: null,
    flight: null,
  };
}

async function seedFixture(input: {
  readonly status?: Round["status"];
  readonly pureTrackStatus?: "pending" | "processing" | "ready" | "failed";
  readonly priorIds?: readonly [number, number];
} = {}): Promise<Fixture> {
  const { user: admin } = await makeUser({ roles: ["Admin"] });
  const pilot = await makePilot();
  await writePrivateJson(`pilots/${pilot.id}.json`, { ...pilot, pureTrackId: 4242 });
  const roundId = randomUUID();
  const teamId = randomUUID();
  const priorIds = input.priorIds;
  const round: Round = {
    id: roundId,
    date: "2026-07-13",
    status: input.status ?? "Locked",
    isLocked: (input.status ?? "Locked") === "Locked",
    maxTeams: 8,
    minimumScore: 0,
    site: { id: randomUUID(), name: "F3 Hill" },
    season: { year: 2026 },
    teams: [{
      id: teamId,
      teamName: "F3 Alpha",
      club: { id: randomUUID(), name: "F3 Club" },
      score: 0,
      pilots: [slot(pilot.id)],
      ...(priorIds === undefined ? {} : {
        pureTrackGroupId: priorIds[1],
        pureTrackGroupSlug: `old-${priorIds[1]}`,
      }),
    }],
    ...(input.pureTrackStatus === undefined ? {} : {
      pureTrack: {
        status: input.pureTrackStatus,
        attemptId: randomUUID(),
        updatedAt: new Date().toISOString(),
      },
    }),
    ...(priorIds === undefined ? {} : {
      pureTrackGroupId: priorIds[0],
      pureTrackGroupName: `Old ${priorIds[0]}`,
      pureTrackGroupSlug: `old-${priorIds[0]}`,
    }),
  };
  const brief: RoundBrief = {
    roundId,
    generatedAt: "2026-07-13T08:00:00.000Z",
    date: round.date,
    siteName: round.site.name,
    teams: [{
      teamName: "F3 Alpha",
      clubName: "F3 Club",
      pilots: [],
      ...(priorIds === undefined ? {} : {
        pureTrackGroupId: priorIds[1],
        pureTrackGroupSlug: `old-${priorIds[1]}`,
      }),
    }],
    ...(priorIds === undefined ? {} : {
      pureTrackGroupName: `Old ${priorIds[0]}`,
      pureTrackGroupSlug: `old-${priorIds[0]}`,
    }),
  };
  const persistedBrief = round.status === "BriefComplete"
    ? { ...brief, hash: computeBriefHash(brief) }
    : brief;
  await writePrivateJson(`rounds/${roundId}.json`, round);
  await writePrivateJson(`round-briefs/${roundId}.json`, persistedBrief);
  if (round.status === "BriefComplete") {
    await writeSignature({
      id: randomUUID(),
      roundId,
      teamId,
      place: 1,
      pilotId: pilot.id,
      userId: admin.id,
      signedAt: new Date().toISOString(),
      briefVersion: 1,
      briefHash: persistedBrief.hash!,
      wordingVersion: 1,
      wordingHash: "f3-wording-hash",
      ip: "203.0.113.3",
      userAgent: "f3-fixture",
      source: "pilot-self",
    });
  }
  if (priorIds !== undefined) {
    await seedGroupRecord(roundId, pilot.id, priorIds[0]);
    await seedGroupRecord(roundId, pilot.id, priorIds[1], teamId);
  }
  return { admin, roundId, teamId, pilotId: pilot.id };
}

async function seedGroupRecord(
  roundId: string,
  pilotId: string,
  externalId: number,
  teamId?: string,
): Promise<string> {
  const id = randomUUID();
  await writePrivateJson(`puretrack-groups/${id}.json`, {
    id,
    name: `Group ${externalId}`,
    slug: `group-${externalId}`,
    pilotIds: [pilotId],
    roundId,
    createdAt: new Date().toISOString(),
    externalId: String(externalId),
    ...(teamId === undefined ? {} : { teamId }),
  });
  return id;
}

function authRequest(fixture: Fixture, method: string, body?: unknown) {
  return makeAuthRequest(fixture.admin.id, fixture.admin.email, {
    method,
    params: { id: fixture.roundId },
    ...(body === undefined ? {} : { body }),
  });
}

async function pollRound(fixture: Fixture): Promise<Round> {
  const response = await invoke("getRoundById", authRequest(fixture, "GET"));
  expect(response.status).toBe(200);
  return RoundSchema.parse(response.jsonBody);
}

function queuedJob(): PureTrackGroupJob {
  const call = queueMock.pureTrack.mock.calls.find((candidate) => candidate.length === 1);
  return PureTrackGroupJobSchema.parse(call?.[0]);
}

function scenarioLog(name: string): readonly WireEntry[] {
  return upstream.log.filter((entry) => entry.scenario === name);
}

function deletedIds(name: string): number[] {
  return scenarioLog(name)
    .filter((entry) => entry.method === "DELETE")
    .map((entry) => Number(entry.url.match(/\/(\d+)$/)?.[1]));
}

function privateBytes(blobPath: string): Promise<Buffer> {
  return getPrivateContainer().getBlobClient(blobPath).downloadToBuffer();
}

beforeEach(() => {
  vi.clearAllMocks();
  blobWriteControl.roundPath = "";
  blobWriteControl.remaining = 0;
  process.env["PURETRACK_ENABLED"] = "true";
  process.env["PURETRACK_API_KEY"] = "f3-key";
  process.env["PURETRACK_EMAIL"] = "f3@example.test";
  process.env["PURETRACK_PASSWORD"] = "f3-secret";
  queueMock.brief.mockResolvedValue(undefined);
  queueMock.pureTrack.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env["PURETRACK_ENABLED"];
  delete process.env["PURETRACK_API_KEY"];
  delete process.env["PURETRACK_EMAIL"];
  delete process.env["PURETRACK_PASSWORD"];
});

afterAll(async () => {
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await fs.writeFile(REQUEST_LOG_PATH, `${JSON.stringify(upstream.log, null, 2)}\n`);
});

describe("F3 deterministic PureTrack registered-handler integration", () => {
  it("lock -> poll pending -> worker -> poll ready materializes round-only echoes", async () => {
    upstream.reset("lock-poll-ready");
    const fixture = await seedFixture({ status: "BriefComplete" });

    const lockedResponse = await invoke("lockRound", authRequest(fixture, "POST"));
    expect(lockedResponse.status).toBe(200);
    const pending = await pollRound(fixture);
    expect(pending.pureTrack?.status).toBe("pending");

    await invokeQueue("pureTrackGroups", queuedJob(), { dequeueCount: 1 });

    const ready = await pollRound(fixture);
    const brief = BriefSchema.parse(
      await readPrivateJson<RoundBrief>(`round-briefs/${fixture.roundId}.json`),
    );
    expect(ready.pureTrack?.status).toBe("ready");
    expect(ready.pureTrackGroupId).toBe(100);
    expect(ready.teams[0]?.pureTrackGroupId).toBe(101);
    expect(brief.pureTrackGroupSlug).toBeUndefined();
    expect(brief.teams[0]?.pureTrackGroupId).toBeUndefined();
  });

  it("manual recreate deletes prior exact IDs before creating replacements", async () => {
    upstream.reset("replacement");
    upstream.seed([
      { id: 10, name: "Old round", slug: "old-10" },
      { id: 11, name: "Old team", slug: "old-11" },
    ]);
    const fixture = await seedFixture({ pureTrackStatus: "ready", priorIds: [10, 11] });

    const response = await invoke("createPureTrackGroups", authRequest(fixture, "POST"));
    expect(response.status).toBe(202);
    await invokeQueue("pureTrackGroups", queuedJob(), { dequeueCount: 1 });

    const log = scenarioLog("replacement");
    const firstCreate = log.findIndex((entry) => entry.method === "POST" && entry.url.endsWith("/api/groups"));
    expect(deletedIds("replacement").slice(0, 2)).toEqual([10, 11]);
    expect(log.findIndex((entry) => entry.method === "DELETE")).toBeLessThan(firstCreate);
    expect((await pollRound(fixture)).pureTrack?.status).toBe("ready");
  });

  it("guard contention throws below dequeue five and re-enqueues at dequeue five", async () => {
    upstream.reset("guard-contention");
    const fixture = await seedFixture({ pureTrackStatus: "pending" });
    const job = { roundId: fixture.roundId, attemptId: (await pollRound(fixture)).pureTrack?.attemptId };
    const parsedJob = PureTrackGroupJobSchema.parse(job);
    const owner = await acquirePureTrackMutationGuard("global", "other-worker");
    if (owner === null) throw new Error("F3 guard setup unexpectedly contended");

    await expect(invokeQueue("pureTrackGroups", parsedJob, { dequeueCount: 4 })).rejects.toThrow(/guard/i);
    await invokeQueue("pureTrackGroups", parsedJob, { dequeueCount: 5 });

    expect(queueMock.pureTrack).toHaveBeenCalledWith(parsedJob, { visibilityTimeoutSeconds: 30 });
    expect(scenarioLog("guard-contention")).toHaveLength(0);
    await releasePureTrackGuard(owner);
  });

  it("takes over a guard after twelve minutes and completes the matching job", async () => {
    upstream.reset("stale-takeover");
    process.env["PURETRACK_ENABLED"] = "false";
    const fixture = await seedFixture({ pureTrackStatus: "pending" });
    const job = PureTrackGroupJobSchema.parse({
      roundId: fixture.roundId,
      attemptId: (await pollRound(fixture)).pureTrack?.attemptId,
    });
    const owner = await acquirePureTrackMutationGuard("global", "stale-worker");
    if (owner === null) throw new Error("F3 stale guard setup unexpectedly contended");
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now + 12 * 60 * 1000 + 1);

    await invokeQueue("pureTrackGroups", job, { dequeueCount: 1 });

    expect((await pollRound(fixture)).pureTrack?.status).toBe("ready");
    expect(scenarioLog("stale-takeover")).toHaveLength(0);
    await releasePureTrackGuard(owner);
  });

  it("admin live-list and bulk-delete remove exact upstream groups, records, and echoes", async () => {
    upstream.reset("admin-delete");
    upstream.seed([
      { id: 30, name: "Admin round", slug: "admin-30" },
      { id: 31, name: "Admin team", slug: "admin-31" },
    ]);
    const fixture = await seedFixture({ pureTrackStatus: "ready", priorIds: [30, 31] });
    const recordsBefore = await listRecordPaths(fixture.roundId);

    const live = await invoke("listLivePureTrackGroups", authRequest(fixture, "GET"));
    const deleted = await invoke(
      "deletePureTrackGroups",
      makeAuthRequest(fixture.admin.id, fixture.admin.email, {
        method: "POST",
        body: { ids: [30, 31] },
      }),
    );

    expect(live.status).toBe(200);
    expect(deleted.status).toBe(200);
    expect(deletedIds("admin-delete")).toEqual([30, 31]);
    const round = await pollRound(fixture);
    const brief = await readPrivateJson<RoundBrief>(`round-briefs/${fixture.roundId}.json`);
    expect(round.pureTrackGroupId).toBeUndefined();
    expect(round.teams[0]?.pureTrackGroupId).toBeUndefined();
    expect(brief?.pureTrackGroupSlug).toBeUndefined();
    expect(brief?.teams[0]?.pureTrackGroupId).toBeUndefined();
    await Promise.all(recordsBefore.map(async (recordPath) => {
      expect(await privateBlobExists(recordPath)).toBe(false);
    }));
  });

  it("disabled worker marks ready without outbound calls or reaping prior state", async () => {
    upstream.reset("disabled");
    process.env["PURETRACK_ENABLED"] = "false";
    const fixture = await seedFixture({ pureTrackStatus: "pending", priorIds: [40, 41] });
    const records = await listRecordPaths(fixture.roundId);
    const job = PureTrackGroupJobSchema.parse({
      roundId: fixture.roundId,
      attemptId: (await pollRound(fixture)).pureTrack?.attemptId,
    });

    await invokeQueue("pureTrackGroups", job, { dequeueCount: 1 });

    const round = await pollRound(fixture);
    expect(round.pureTrack?.status).toBe("ready");
    expect(round.pureTrackGroupId).toBe(40);
    expect(scenarioLog("disabled")).toHaveLength(0);
    await Promise.all(records.map(async (recordPath) => {
      expect(await privateBlobExists(recordPath)).toBe(true);
    }));
  });

  it.each(["pending", "processing"] as const)(
    "unlock returns 409 and preserves both blobs while PureTrack is %s",
    async (status) => {
      upstream.reset(`unlock-${status}`);
      const fixture = await seedFixture({ pureTrackStatus: status, priorIds: [50, 51] });
      const roundPath = `rounds/${fixture.roundId}.json`;
      const briefPath = `round-briefs/${fixture.roundId}.json`;
      const beforeRound = await privateBytes(roundPath);
      const beforeBrief = await privateBytes(briefPath);

      const response = await invoke("unlockRound", authRequest(fixture, "POST"));

      expect(response.status).toBe(409);
      expect(response.jsonBody).toMatchObject({ code: "PURETRACK_IN_PROGRESS" });
      expect(await privateBytes(roundPath)).toEqual(beforeRound);
      expect(await privateBytes(briefPath)).toEqual(beforeBrief);
    },
  );

  it("unlock clears ready round and brief echoes together without upstream deletion", async () => {
    upstream.reset("unlock-ready");
    const fixture = await seedFixture({ pureTrackStatus: "ready", priorIds: [52, 53] });

    const response = await invoke("unlockRound", authRequest(fixture, "POST"));

    expect(response.status).toBe(200);
    const round = await pollRound(fixture);
    const brief = await readPrivateJson<RoundBrief>(`round-briefs/${fixture.roundId}.json`);
    expect(round.pureTrack).toBeUndefined();
    expect(round.pureTrackGroupId).toBeUndefined();
    expect(round.teams[0]?.pureTrackGroupId).toBeUndefined();
    expect(brief?.pureTrackGroupSlug).toBeUndefined();
    expect(brief?.teams[0]?.pureTrackGroupId).toBeUndefined();
    expect(scenarioLog("unlock-ready")).toHaveLength(0);
  });

  it("malformed create response cleans the exact recovered upstream ID", async () => {
    upstream.reset("create-failure-cleanup");
    upstream.malformedCreate = true;
    const fixture = await seedFixture({ pureTrackStatus: "pending" });
    const job = PureTrackGroupJobSchema.parse({
      roundId: fixture.roundId,
      attemptId: (await pollRound(fixture)).pureTrack?.attemptId,
    });

    await invokeQueue("pureTrackGroups", job, { dequeueCount: 5 });

    expect(deletedIds("create-failure-cleanup")).toEqual([100]);
    expect((await pollRound(fixture)).pureTrack?.status).toBe("failed");
  });

  it("import failure cleans every invocation-created exact ID", async () => {
    upstream.reset("import-failure-cleanup");
    upstream.failImport = true;
    const fixture = await seedFixture({ pureTrackStatus: "pending" });
    const job = PureTrackGroupJobSchema.parse({
      roundId: fixture.roundId,
      attemptId: (await pollRound(fixture)).pureTrack?.attemptId,
    });

    await invokeQueue("pureTrackGroups", job, { dequeueCount: 5 });

    expect(deletedIds("import-failure-cleanup")).toEqual([100, 101]);
    expect((await pollRound(fixture)).pureTrack?.status).toBe("failed");
  });

  it("cross-blob round-write failure restores the exact pre-commit brief", async () => {
    upstream.reset("round-write-brief-restore");
    const fixture = await seedFixture({ pureTrackStatus: "pending" });
    const briefPath = `round-briefs/${fixture.roundId}.json`;
    const beforeBrief = await privateBytes(briefPath);
    const job = PureTrackGroupJobSchema.parse({
      roundId: fixture.roundId,
      attemptId: (await pollRound(fixture)).pureTrack?.attemptId,
    });
    upstream.onImport = (groupId) => {
      if (groupId !== 100) return;
      blobWriteControl.roundPath = `rounds/${fixture.roundId}.json`;
      blobWriteControl.remaining = 1;
    };

    await invokeQueue("pureTrackGroups", job, { dequeueCount: 5 });

    expect(await privateBytes(briefPath)).toEqual(beforeBrief);
    expect((await pollRound(fixture)).pureTrack?.status).toBe("failed");
  });

});

async function listRecordPaths(roundId: string): Promise<string[]> {
  const paths: string[] = [];
  for await (const item of getPrivateContainer().listBlobsFlat({ prefix: "puretrack-groups/" })) {
    const record = await readPrivateJson<{ readonly roundId?: string }>(item.name);
    if (record?.roundId === roundId) paths.push(item.name);
  }
  return paths;
}
