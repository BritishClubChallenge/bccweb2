// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import * as z from "zod/v4";
import { getTelemetryClient } from "./telemetry.js";

const BASE_URL = "https://puretrack.io";
export const PURETRACK_REQUEST_TIMEOUT_MS = 60_000;

// Inbound puretrack.io responses: never `.strict()`. Unknown keys must be stripped, not
// rejected — a `.strict()` login schema 500'd staging when PureTrack added a `pro` field.
export const PureTrackLoginResponseSchema = z.object({
  access_token: z.string().min(1),
});
export const PureTrackGroupCleanupTokenSchema = z.looseObject({
  id: z.number().int().positive(),
});
export const PureTrackApiGroupSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  slug: z.string().min(1),
});
export const PureTrackListGroupsResponseSchema = z.object({
  data: z.array(PureTrackApiGroupSchema),
});

export type PureTrackApiGroup = z.infer<typeof PureTrackApiGroupSchema>;
export type BeforePureTrackOutbound = () => Promise<void>;

export interface PureTrackSession {
  readonly accessToken: string;
  readonly csrfToken: string;
  readonly cookieHeader: string;
}

export class PureTrackCreateResponseError extends Error {
  readonly name = "PureTrackCreateResponseError";

  constructor(
    public readonly cleanupId: number | undefined,
    cause: unknown,
  ) {
    super("PureTrack create response did not match the required schema", { cause });
  }
}

export class PureTrackDeleteError extends Error {
  readonly name = "PureTrackDeleteError";

  constructor(
    public readonly deletedIds: readonly number[],
    public readonly alreadyGoneIds: readonly number[],
    public readonly failedId: number,
    cause: unknown,
  ) {
    super(`PureTrack group ${failedId} could not be deleted`, { cause });
  }
}

export async function authenticate(
  beforeOutbound: BeforePureTrackOutbound,
): Promise<PureTrackSession> {
  const apiKey = process.env["PURETRACK_API_KEY"];
  const email = process.env["PURETRACK_EMAIL"];
  const password = process.env["PURETRACK_PASSWORD"];
  if (!apiKey || !email || !password) {
    throw new Error(
      "PURETRACK_API_KEY, PURETRACK_EMAIL, and PURETRACK_PASSWORD must all be set",
    );
  }

  await beforeOutbound();
  const loginRes = await fetchPureTrack(`${BASE_URL}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: apiKey, email, password }),
  });
  if (!loginRes.ok) {
    throw new Error(
      `PureTrack login failed (${loginRes.status}): ${await loginRes.text()}`,
    );
  }
  const { access_token: accessToken } = PureTrackLoginResponseSchema.parse(
    await loginRes.json(),
  );
  const rawCookies = loginRes.headers.getSetCookie?.() ?? [];
  const loginCookieHeader = rawCookies.map((cookie) => cookie.split(";")[0]).join("; ");
  await beforeOutbound();
  const csrfRes = await fetchPureTrack(`${BASE_URL}/login`, {
    headers: { Cookie: loginCookieHeader },
  });
  const csrfHtml = await csrfRes.text();
  const cookieMap = new Map<string, string>();
  for (const cookie of [...rawCookies, ...(csrfRes.headers.getSetCookie?.() ?? [])]) {
    const value = cookie.split(";")[0]?.trim();
    const name = value?.split("=")[0];
    if (value && name) cookieMap.set(name, value);
  }
  const cookieHeader = [...cookieMap.values()].join("; ");
  const patterns = [
    /name="XSRF-TOKEN"\s+content="([^"]+)"/,
    /content="([^"]+)"\s+name="XSRF-TOKEN"/,
    /<meta\s+name=['"]XSRF-TOKEN['"]\s+content=['"]([^'"]+)['"]/,
    /<meta name="csrf-token" content="([^"]+)"/,
  ];
  let csrfToken = patterns
    .map((pattern) => csrfHtml.match(pattern)?.[1])
    .find((token): token is string => token !== undefined) ?? "";
  if (!csrfToken) {
    const cookie = cookieMap.get("XSRF-TOKEN");
    if (cookie) csrfToken = decodeURIComponent(cookie.replace("XSRF-TOKEN=", ""));
  }
  if (!csrfToken) {
    throw new Error(
      "Could not extract XSRF-TOKEN from PureTrack login page. The page may have changed.",
    );
  }
  return { accessToken, csrfToken, cookieHeader };
}

function authHeaders(session: PureTrackSession): Record<string, string> {
  return {
    Authorization: `Bearer ${session.accessToken}`,
    "X-XSRF-TOKEN": session.csrfToken,
    "Content-Type": "application/json",
    Cookie: session.cookieHeader,
  };
}

export async function createGroup(
  name: string,
  beforeOutbound: BeforePureTrackOutbound,
  sharedSession?: PureTrackSession,
): Promise<PureTrackApiGroup> {
  const session = sharedSession ?? await authenticate(beforeOutbound);
  await beforeOutbound();
  const res = await fetchPureTrack(`${BASE_URL}/api/groups`, {
    method: "POST",
    headers: authHeaders(session),
    body: JSON.stringify({
      id: null,
      name,
      public: true,
      event: false,
      protected: false,
      password: "oshi",
      timezone: "Europe/London",
      slug: name,
      start: null,
      end: null,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `PureTrack createGroup("${name}") failed (${res.status}): ${await res.text()}`,
    );
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch (cause: unknown) {
    trackOrphanRecovery();
    throw new PureTrackCreateResponseError(undefined, cause);
  }
  const cleanupToken = PureTrackGroupCleanupTokenSchema.safeParse(raw);
  const group = PureTrackApiGroupSchema.safeParse(raw);
  if (group.success) return group.data;
  if (!cleanupToken.success) trackOrphanRecovery();
  throw new PureTrackCreateResponseError(
    cleanupToken.success ? cleanupToken.data.id : undefined,
    group.error,
  );
}

function trackOrphanRecovery(): void {
  getTelemetryClient()?.trackEvent({
    name: "puretrack.orphanRecoveryRequired",
    properties: { operation: "createGroup" },
  });
}

export async function importPilots(
  groupId: number,
  pureTrackIds: readonly number[],
  beforeOutbound: BeforePureTrackOutbound,
  sharedSession?: PureTrackSession,
): Promise<void> {
  if (pureTrackIds.length === 0) return;
  const session = sharedSession ?? await authenticate(beforeOutbound);
  await beforeOutbound();
  const res = await fetchPureTrack(`${BASE_URL}/api/groups/${groupId}/import-ids`, {
    method: "POST",
    headers: authHeaders(session),
    body: JSON.stringify({ ids: pureTrackIds.join(",") }),
  });
  if (!res.ok) {
    throw new Error(
      `PureTrack importPilots(group=${groupId}) failed (${res.status}): ${await res.text()}`,
    );
  }
}

export async function listMyGroups(
  session: PureTrackSession,
  beforeOutbound: BeforePureTrackOutbound,
): Promise<PureTrackApiGroup[]> {
  await beforeOutbound();
  const res = await fetchPureTrack(`${BASE_URL}/api/groups?mine=1`, {
    headers: authHeaders(session),
  });
  if (!res.ok) {
    throw new Error(
      `PureTrack listMyGroups failed (${res.status}): ${await res.text()}`,
    );
  }
  return PureTrackListGroupsResponseSchema.parse(await res.json()).data;
}

export async function deleteGroups(
  session: PureTrackSession,
  ids: readonly number[],
  beforeOutbound: BeforePureTrackOutbound,
): Promise<{ readonly deletedIds: readonly number[]; readonly alreadyGoneIds: readonly number[] }> {
  const deletedIds: number[] = [];
  const alreadyGoneIds: number[] = [];
  for (const id of ids) {
    try {
      await beforeOutbound();
      const res = await fetchPureTrack(`${BASE_URL}/api/groups/${id}`, {
        method: "DELETE",
        headers: authHeaders(session),
      });
      if (res.ok) {
        deletedIds.push(id);
        continue;
      }
      if (res.status === 404 || res.status === 410) {
        alreadyGoneIds.push(id);
        continue;
      }
      throw new Error(
        `PureTrack delete group ${id} failed (${res.status}): ${await res.text()}`,
      );
    } catch (cause: unknown) {
      throw new PureTrackDeleteError(deletedIds, alreadyGoneIds, id, cause);
    }
  }
  return { deletedIds, alreadyGoneIds };
}

async function fetchPureTrack(
  input: string,
  init: RequestInit,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(PURETRACK_REQUEST_TIMEOUT_MS);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  return fetch(input, { ...init, signal });
}
