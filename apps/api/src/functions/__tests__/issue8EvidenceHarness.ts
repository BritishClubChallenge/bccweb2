// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  CallerIdentity,
  User,
  UserRole,
} from "@bccweb/types";
import { expect } from "vitest";
import { invoke } from "../../__tests__/helpers/api.js";
import { writePrivateJson } from "../../__tests__/helpers/seed.js";
import {
  mutationRateLimit,
  type MutationRateLimitTier,
} from "../../lib/rateLimit.js";
import { ROUND_TRANSITIONS } from "../../lib/roundTransitions.js";
import { EvidenceHttpRequest } from "./issue8EvidenceRequest.js";

/** Handler modules scanned for LITERAL mutationRateLimit call sites. */
export const SOURCE_FILES = [
  "admin.ts",
  "adminWording.ts",
  "brief.ts",
  "clubTeams.ts",
  "clubs.ts",
  "flights.ts",
  "pilots.ts",
  "pilotSeasonClubs.ts",
  "puretrack.ts",
  "roundsMutate.ts",
  "seasonClubs.ts",
  "seasons.ts",
  "sites.ts",
  "teams.ts",
  "teamsCaptain.ts",
] as const;

/**
 * Modules OUTSIDE functions/ that gate on mutationRateLimit. Kept separate from
 * SOURCE_FILES because that list is resolved against the functions directory —
 * appending to it would send the scanner looking for functions/roundTransitions.ts.
 */
export const TABLE_SOURCE_FILES = ["roundTransitions.ts"] as const;

export type EvidenceSourceFile =
  | (typeof SOURCE_FILES)[number]
  | (typeof TABLE_SOURCE_FILES)[number];

export type TestUser = {
  readonly id: string;
  readonly email: string;
  readonly roles: UserRole[];
  readonly pilotId: string | null;
  readonly clubId: string | null;
};

export type HarnessRequest = {
  readonly method: string;
  readonly params?: Record<string, string>;
  readonly query?: Record<string, string>;
  readonly body?: unknown;
};

export type CaseContext = {
  readonly forbidden: TestUser;
  readonly request: HarnessRequest;
};

export type CallSiteCase = {
  readonly file: EvidenceSourceFile;
  readonly handler: string;
  readonly endpoint: string;
  readonly tier: MutationRateLimitTier;
  readonly forbiddenKind:
    | "admin-only"
    | "coord-coarse"
    | "coord-scope"
    | "self-or-admin";
  readonly setup: () => Promise<CaseContext>;
};

type InvokeResult = {
  readonly status: number;
  readonly jsonBody?: unknown;
  readonly headers?: Headers | Record<string, string>;
};

const CAPACITY_BY_TIER: Record<MutationRateLimitTier, number> = {
  standard: 30,
  heavy: 5,
  flights: 60,
};

export async function seedEvidenceUser({
  roles,
  clubId = null,
  pilotId = null,
}: {
  readonly roles: UserRole[];
  readonly clubId?: string | null;
  readonly pilotId?: string | null;
}): Promise<TestUser> {
  const id = randomUUID();
  const email = `issue8-${id.slice(0, 8)}@example.test`;
  const user: User = {
    id,
    email,
    roles,
    clubId,
    pilotId,
    createdAt: new Date().toISOString(),
  };
  await writePrivateJson(`users/${id}.json`, user);
  return { id, email, roles, clubId, pilotId };
}

export function makeEvidenceRequest(
  user: TestUser,
  request: HarnessRequest
): EvidenceHttpRequest {
  return new EvidenceHttpRequest(user, request);
}

export async function invokeEvidenceHandler(
  handlerName: string,
  request: EvidenceHttpRequest
): Promise<InvokeResult> {
  const response = await invoke(handlerName, request);
  return {
    status: response.status ?? 200,
    jsonBody: response.jsonBody,
    headers: response.headers as InvokeResult["headers"],
  };
}

export function retryAfter(response: InvokeResult): string | undefined {
  if (!response.headers) return undefined;
  if (response.headers instanceof Headers) {
    return response.headers.get("Retry-After") ?? undefined;
  }
  return response.headers["Retry-After"] ?? response.headers["retry-after"];
}

export async function saturateOwnBucket(
  row: CallSiteCase,
  context: CaseContext
): Promise<void> {
  const caller: CallerIdentity = {
    userId: context.forbidden.id,
    email: context.forbidden.email,
    roles: context.forbidden.roles,
    pilotId: context.forbidden.pilotId,
    clubId: context.forbidden.clubId,
  };
  let rejected = false;
  const maxAttempts = CAPACITY_BY_TIER[row.tier] * 2 + 10;
  for (let index = 0; index < maxAttempts; index += 1) {
    try {
      await mutationRateLimit(
        makeEvidenceRequest(context.forbidden, context.request),
        caller,
        row.endpoint,
        row.tier
      );
    } catch (err: unknown) {
      expect((err as { status?: number }).status).toBe(429);
      rejected = true;
      break;
    }
  }
  expect(rejected).toBe(true);
}

export function adminOnly(
  method: string,
  params: Record<string, string> = {},
  body: unknown = {},
  query: Record<string, string> = {}
): () => Promise<CaseContext> {
  return async () => ({
    forbidden: await seedEvidenceUser({
      roles: ["Pilot"],
      pilotId: randomUUID(),
    }),
    request: { method, params, query, body },
  });
}

export function coordCoarse(
  method: string,
  params: Record<string, string> = {},
  body: unknown = {},
  query: Record<string, string> = {}
): () => Promise<CaseContext> {
  return adminOnly(method, params, body, query);
}

export async function crossClubCoord(): Promise<TestUser> {
  return seedEvidenceUser({ roles: ["RoundsCoord"], clubId: randomUUID() });
}

/**
 * Every mutationRateLimit gate in the API, as `{file, endpoint, tier}` rows.
 *
 * Two scanners, because there are two shapes of call site:
 * 1. handler modules pass string LITERALS, so the regex reads them directly;
 * 2. lib/roundTransitions.ts passes `spec.endpoint` / `spec.tier` from
 *    ROUND_TRANSITIONS, which no regex can resolve — so the source scan only
 *    proves the gate is still THERE, and the rows are derived from the table
 *    itself. Deriving beats re-listing: the evidence cannot drift from the
 *    table, and deleting the gate empties the rows rather than silently
 *    passing.
 */
export async function sourceMutationCallSites(
  functionsDirectory: string
): Promise<readonly { file: string; endpoint: string; tier: string }[]> {
  const rows: Array<{ file: string; endpoint: string; tier: string }> = [];
  const literalPattern =
    /mutationRateLimit\(\s*req,\s*caller,\s*"([^"]+)",\s*"([^"]+)"\s*\)/g;
  for (const file of SOURCE_FILES) {
    const source = await fs.readFile(path.join(functionsDirectory, file), "utf8");
    for (const match of source.matchAll(literalPattern)) {
      rows.push({ file, endpoint: match[1], tier: match[2] });
    }
  }

  const tablePattern =
    /mutationRateLimit\(\s*req,\s*caller,\s*spec\.endpoint,\s*spec\.tier\s*\)/g;
  const libraryDirectory = path.resolve(functionsDirectory, "..", "lib");
  for (const file of TABLE_SOURCE_FILES) {
    const source = await fs.readFile(path.join(libraryDirectory, file), "utf8");
    const gates = source.match(tablePattern)?.length ?? 0;
    for (let gate = 0; gate < gates; gate += 1) {
      for (const spec of Object.values(ROUND_TRANSITIONS)) {
        rows.push({ file, endpoint: spec.endpoint, tier: spec.tier });
      }
    }
  }

  return rows;
}
