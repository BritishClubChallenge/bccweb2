// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Round } from "@bccweb/types";

const fetchMock = vi.fn<typeof fetch>();
const trackEventSpy = vi.hoisted(() => vi.fn());
const writePrivateBlobSpy = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../blob.js", () => ({
  getPrivateBlobClient: vi.fn(),
  writePrivateBlob: writePrivateBlobSpy,
}));
vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => ({ trackEvent: trackEventSpy }),
}));

const session = { accessToken: "token", csrfToken: "csrf", cookieHeader: "session=cookie" } as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}

function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== "string") throw new Error("Expected a string request body");
  return init.body;
}

function makeRound(): Round {
  return {
    id: "round-1",
    date: "2026-06-09",
    status: "Locked",
    isLocked: true,
    maxTeams: 8,
    minimumScore: 0,
    site: { id: "site-1", name: "Milk Hill" },
    season: { year: 2026 },
    teams: [{
      id: "team-1",
      teamName: "Alpha",
      club: { id: "club-1", name: "Club" },
      score: 0,
      pilots: [
        { placeInTeam: 1, isScoring: true, status: "Filled", accountedFor: false, signToFly: false, noScore: false, pilotPoints: 0, pilotId: "pilot-1", snapshot: null, flight: null },
        { placeInTeam: 2, isScoring: true, status: "Filled", accountedFor: false, signToFly: false, noScore: false, pilotPoints: 0, pilotId: "pilot-2", snapshot: null, flight: null },
      ],
    }],
  };
}

describe("PureTrack API contracts", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    trackEventSpy.mockReset();
    writePrivateBlobSpy.mockReset();
    writePrivateBlobSpy.mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);
    process.env["PURETRACK_API_KEY"] = "key";
    process.env["PURETRACK_EMAIL"] = "pilot@example.com";
    process.env["PURETRACK_PASSWORD"] = "secret";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env["PURETRACK_API_KEY"];
    delete process.env["PURETRACK_EMAIL"];
    delete process.env["PURETRACK_PASSWORD"];
  });

  it.each([
    { access_token: "" },
    {},
  ])("rejects a login response without a usable access token: %s", async (body) => {
    const { authenticate } = await import("../puretrack.js");
    const beforeOutbound = vi.fn().mockResolvedValue(undefined);
    fetchMock.mockResolvedValueOnce(jsonResponse(body));

    await expect(authenticate(beforeOutbound)).rejects.toThrow();

    expect(beforeOutbound).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("tolerates unexpected keys in the login response (regression: PureTrack added `pro`)", async () => {
    const { authenticate } = await import("../puretrack.js");
    const beforeOutbound = vi.fn().mockResolvedValue(undefined);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: "token", pro: true }))
      .mockResolvedValueOnce(new Response('<meta name="csrf-token" content="csrf-xyz">', {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }));

    const result = await authenticate(beforeOutbound);

    expect(result).toEqual({ accessToken: "token", csrfToken: "csrf-xyz", cookieHeader: "" });
    expect(beforeOutbound).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reuses one authenticated session for list and create calls", async () => {
    const { createGroup, listMyGroups } = await import("../puretrack.js");
    const beforeOutbound = vi.fn().mockResolvedValue(undefined);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 7, name: "Round", slug: "round" }] }))
      .mockResolvedValueOnce(jsonResponse({ id: 8, name: "Team", slug: "team" }));

    const groups = await listMyGroups(session, beforeOutbound);
    const created = await createGroup("Team", beforeOutbound, session);

    expect(groups).toEqual([{ id: 7, name: "Round", slug: "round" }]);
    expect(created).toEqual({ id: 8, name: "Team", slug: "team" });
    expect(fetchMock.mock.calls.map(([url]) => requestUrl(url))).toEqual([
      "https://puretrack.io/api/groups?mine=1",
      "https://puretrack.io/api/groups",
    ]);
    expect(beforeOutbound).toHaveBeenCalledTimes(2);
  });

  it("checks the fence again before the CSRF request", async () => {
    // Given
    const { authenticate } = await import("../puretrack.js");
    const guardLost = new Error("guard lost");
    const beforeOutbound = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(guardLost);
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: "token" }));

    // When / Then
    await expect(authenticate(beforeOutbound)).rejects.toBe(guardLost);
    expect(beforeOutbound).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks listing when the outbound fence is lost", async () => {
    // Given
    const { listMyGroups } = await import("../puretrack.js");
    const guardLost = new Error("guard lost");
    const beforeOutbound = vi.fn().mockRejectedValueOnce(guardLost);

    // When / Then
    await expect(listMyGroups(session, beforeOutbound)).rejects.toBe(guardLost);
    expect(beforeOutbound).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each<readonly [unknown, string]>([
    [{ data: [{ id: 1, name: "Name" }] }, "missing group field"],
    [{ data: [{ id: 0, name: "Name", slug: "slug" }] }, "non-positive group id"],
    [{ groups: [] }, "missing data"],
  ])("rejects a malformed list response: %s (%s)", async (body) => {
    const { listMyGroups } = await import("../puretrack.js");
    fetchMock.mockResolvedValueOnce(jsonResponse(body));

    await expect(listMyGroups(session, vi.fn().mockResolvedValue(undefined))).rejects.toThrow();
  });

  it("tolerates and strips unexpected keys in a list response and its groups", async () => {
    const { listMyGroups } = await import("../puretrack.js");
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: [{ id: 1, name: "Name", slug: "slug", pro: true }],
      extra: true,
    }));

    const groups = await listMyGroups(session, vi.fn().mockResolvedValue(undefined));

    expect(groups).toEqual([{ id: 1, name: "Name", slug: "slug" }]);
  });

  it("preserves a valid cleanupId when the full create response is malformed", async () => {
    const { createGroup, PureTrackCreateResponseError } = await import("../puretrack.js");
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 41, name: "Name" }));

    const error = await createGroup("Name", vi.fn().mockResolvedValue(undefined), session).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PureTrackCreateResponseError);
    expect(error).toMatchObject({ cleanupId: 41 });
    expect(trackEventSpy).not.toHaveBeenCalled();
  });

  it("returns a created group with unexpected keys stripped instead of treating it as an orphan", async () => {
    const { createGroup } = await import("../puretrack.js");
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 41, name: "Name", slug: "slug", pro: true }));

    const created = await createGroup("Name", vi.fn().mockResolvedValue(undefined), session);

    expect(created).toEqual({ id: 41, name: "Name", slug: "slug" });
    expect(trackEventSpy).not.toHaveBeenCalled();
  });

  it("emits orphan telemetry when malformed create JSON has no safe cleanup id", async () => {
    const { createGroup, PureTrackCreateResponseError } = await import("../puretrack.js");
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "41", name: "Name", slug: "slug" }));

    const error = await createGroup("Name", vi.fn().mockResolvedValue(undefined), session).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PureTrackCreateResponseError);
    expect(error).toMatchObject({ cleanupId: undefined });
    expect(trackEventSpy).toHaveBeenCalledWith({
      name: "puretrack.orphanRecoveryRequired",
      properties: { operation: "createGroup" },
    });
  });

  it("sends the unchanged group body after the outbound fence", async () => {
    const { createGroup } = await import("../puretrack.js");
    const order: string[] = [];
    const beforeOutbound = vi.fn(async () => { order.push("fence"); });
    fetchMock.mockImplementationOnce(async (_url, init) => {
      order.push("post");
      expect(JSON.parse(requestBody(init))).toEqual({
        id: null,
        name: "BCC Team",
        public: true,
        event: false,
        protected: false,
        password: "oshi",
        timezone: "Europe/London",
        slug: "BCC Team",
        start: null,
        end: null,
      });
      return jsonResponse({ id: 5, name: "BCC Team", slug: "bcc-team" });
    });

    await createGroup("BCC Team", beforeOutbound, session);

    expect(order).toEqual(["fence", "post"]);
  });

  it("reports sequential mid-batch delete progress and tolerates already-gone groups", async () => {
    const { deleteGroups, PureTrackDeleteError } = await import("../puretrack.js");
    const beforeOutbound = vi.fn().mockResolvedValue(undefined);
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 410 }))
      .mockResolvedValueOnce(new Response("upstream failed", { status: 500 }));

    const error = await deleteGroups(session, [11, 12, 13, 14, 15], beforeOutbound).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PureTrackDeleteError);
    expect(error).toMatchObject({
      deletedIds: [11],
      alreadyGoneIds: [12, 13],
      failedId: 14,
    });
    expect(error).toHaveProperty("cause");
    expect(beforeOutbound).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.map(([url]) => requestUrl(url))).toEqual([
      "https://puretrack.io/api/groups/11",
      "https://puretrack.io/api/groups/12",
      "https://puretrack.io/api/groups/13",
      "https://puretrack.io/api/groups/14",
    ]);
  });

  it("returns the actual deleted and already-gone ids after a successful delete batch", async () => {
    // Given
    const { deleteGroups } = await import("../puretrack.js");
    const beforeOutbound = vi.fn().mockResolvedValue(undefined);
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 410 }));

    // When
    const result = await deleteGroups(session, [21, 22, 23], beforeOutbound);

    // Then
    expect(result).toEqual({ deletedIds: [21], alreadyGoneIds: [22, 23] });
  });

  it("aborts a PureTrack request at the request timeout", async () => {
    // Given
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
        delay,
      );
      return controller.signal;
    });
    const { listMyGroups, PURETRACK_REQUEST_TIMEOUT_MS } = await import("../puretrack.js");
    fetchMock.mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));

    // When
    const request = listMyGroups(session, vi.fn().mockResolvedValue(undefined));
    const rejection = expect(request).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(PURETRACK_REQUEST_TIMEOUT_MS);

    // Then
    await rejection;
  });

  it("aborts a stalled PureTrack response body at the request timeout", async () => {
    // Given
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
        delay,
      );
      return controller.signal;
    });
    const { listMyGroups, PURETRACK_REQUEST_TIMEOUT_MS } = await import("../puretrack.js");
    let rejectBody: ((reason: unknown) => void) | undefined;
    let requestSignal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce(async (_input, init) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) throw new Error("Expected a request abort signal");
      requestSignal = signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          rejectBody = (reason) => controller.error(reason);
          signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
          controller.enqueue(new TextEncoder().encode('{"data":'));
        },
      });
      return new Response(body, { headers: { "Content-Type": "application/json" } });
    });

    // When
    const request = listMyGroups(session, vi.fn().mockResolvedValue(undefined));
    const rejection = expect(request).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(PURETRACK_REQUEST_TIMEOUT_MS);
    const timedOut = requestSignal?.aborted === true;
    if (!timedOut) rejectBody?.(new Error("Response body timeout was cleared after headers"));

    // Then
    await rejection;
    expect(timedOut).toBe(true);
  });
});

describe("createPureTrackGroups guarded orchestration", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    writePrivateBlobSpy.mockReset();
    writePrivateBlobSpy.mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(globalThis, "setTimeout").mockImplementation((callback: () => void) => {
      callback();
      return 0 as never;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reuses a supplied session and sends comma-free generated group names", async () => {
    const { createPureTrackGroups } = await import("../puretrack.js");
    const beforeOutbound = vi.fn().mockResolvedValue(undefined);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 1, name: "Round", slug: "round" }))
      .mockResolvedValueOnce(jsonResponse({ id: 2, name: "Team", slug: "team" }))
      .mockResolvedValueOnce(new Response("ok"))
      .mockResolvedValueOnce(new Response("ok"));

    const result = await createPureTrackGroups(makeRound(), new Map([["pilot-1", 101]]), {
      beforeOutbound,
      session,
    });

    expect(result?.roundGroupId).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.some(([url]) => requestUrl(url).endsWith("/api/login"))).toBe(false);
    const createBodies = fetchMock.mock.calls
      .filter(([url, init]) => requestUrl(url).endsWith("/api/groups") && init?.method === "POST")
      .map(([, init]) => JSON.parse(requestBody(init)) as { name: string });
    expect(createBodies.map(({ name }) => name)).toEqual([
      "BCC Milk Hill Tue 09 Jun 26",
      "BCC Tue 09 Jun 26 Alpha",
    ]);
    expect(createBodies.every(({ name }) => !name.includes(","))).toBe(true);
    expect(fetchMock.mock.calls.every(([, init]) => {
      const headers = new Headers(init?.headers);
      return headers.get("Authorization") === "Bearer token" &&
        headers.get("Cookie") === "session=cookie";
    })).toBe(true);
    expect(beforeOutbound).toHaveBeenCalledTimes(4);
    expect(writePrivateBlobSpy).toHaveBeenCalledTimes(2);
  });

  it("carries the round id when its record write and immediate delete both fail", async () => {
    // Given
    const { createPureTrackGroups, PureTrackGroupOperationError } = await import("../puretrack.js");
    const recordError = new Error("record write failed");
    const beforeOutbound = vi.fn().mockResolvedValue(undefined);
    writePrivateBlobSpy.mockRejectedValueOnce(recordError);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 31, name: "Round", slug: "round" }))
      .mockResolvedValueOnce(new Response("delete failed", { status: 500 }));

    // When
    const error = await createPureTrackGroups(makeRound(), new Map([["pilot-1", 101]]), {
      beforeOutbound,
      session,
    }).catch((cause: unknown) => cause);

    // Then
    expect(error).toBeInstanceOf(PureTrackGroupOperationError);
    expect(error).toMatchObject({ cleanupIds: [31], cause: recordError });
    expect(fetchMock.mock.calls.map(([url]) => requestUrl(url))).toEqual([
      "https://puretrack.io/api/groups",
      "https://puretrack.io/api/groups/31",
    ]);
    expect(beforeOutbound).toHaveBeenCalledTimes(2);
  });

  it("carries round and team ids when a team record write and immediate delete both fail", async () => {
    // Given
    const { createPureTrackGroups, PureTrackGroupOperationError } = await import("../puretrack.js");
    const recordError = new Error("team record write failed");
    const beforeOutbound = vi.fn().mockResolvedValue(undefined);
    writePrivateBlobSpy
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(recordError);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 41, name: "Round", slug: "round" }))
      .mockResolvedValueOnce(jsonResponse({ id: 42, name: "Team", slug: "team" }))
      .mockResolvedValueOnce(new Response("delete failed", { status: 500 }));

    // When
    const error = await createPureTrackGroups(makeRound(), new Map([["pilot-1", 101]]), {
      beforeOutbound,
      session,
    }).catch((cause: unknown) => cause);

    // Then
    expect(error).toBeInstanceOf(PureTrackGroupOperationError);
    expect(error).toMatchObject({ cleanupIds: [41, 42], cause: recordError });
    expect(fetchMock.mock.calls.map(([url]) => requestUrl(url))).toEqual([
      "https://puretrack.io/api/groups",
      "https://puretrack.io/api/groups",
      "https://puretrack.io/api/groups/42",
    ]);
  });

  it("carries every exact cleanup id after a partial import failure", async () => {
    const { createPureTrackGroups, PureTrackGroupOperationError } = await import("../puretrack.js");
    const beforeOutbound = vi.fn().mockResolvedValue(undefined);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 51, name: "Round", slug: "round" }))
      .mockResolvedValueOnce(jsonResponse({ id: 52, name: "Team", slug: "team" }))
      .mockResolvedValueOnce(new Response("import failed", { status: 500 }));

    const error = await createPureTrackGroups(makeRound(), new Map([["pilot-1", 101]]), {
      beforeOutbound,
      session,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PureTrackGroupOperationError);
    expect(error).toMatchObject({ cleanupIds: [51, 52] });
  });

  it("preserves team and round skip semantics when pilots lack PureTrack ids", async () => {
    const { createPureTrackGroups } = await import("../puretrack.js");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await createPureTrackGroups(makeRound(), new Map());

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });
});
