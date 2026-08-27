// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "crypto";
import { BlockBlobClient } from "@azure/storage-blob";
import type { User, UserIndex, Pilot, Round, Club, ClubTeam, Site, Config, WingClass, RoundStatus } from "@bccweb/types";
import type { HttpResponseInit } from "@azure/functions";
import type { AuthCredential } from "../../lib/authHelpers.js";
import { signAccessToken } from "../../lib/authHelpers.js";
import { getPublicContainer, getPrivateContainer } from "./azurite.js";
import { invoke, makeAuthRequest, makeRequest } from "./api.js";
import { clearSentEmails, getLastVerificationUrl } from "./setup.js";

import "../../index.js";

// DIRECT BLOB ACCESS — permitted ONLY for: (1) bootstrapAdmin; (2) controlled
// fixture overrides that handlers cannot express (IDs, teams, normalized state);
// (3) deliberately corrupt fixtures in negative healing-layer tests; and
// (4) assertion reads. Any other use is a bug. Keep packages/schemas/AGENTS.md
// and docs/architecture/storage-and-queues.md aligned with this allowlist.

async function writeJson<T>(
  containerFn: () => import("@azure/storage-blob").ContainerClient,
  path: string,
  data: T,
): Promise<void> {
  const client: BlockBlobClient = containerFn().getBlockBlobClient(path);
  const content = JSON.stringify(data, null, 2);
  await client.upload(content, Buffer.byteLength(content), {
    blobHTTPHeaders: { blobContentType: "application/json" },
  });
}

export async function readJson<T>(
  containerFn: () => import("@azure/storage-blob").ContainerClient,
  path: string,
): Promise<T | null> {
  const client = containerFn().getBlobClient(path);
  try {
    const response = await client.download();
    const chunks: Buffer[] = [];
    for await (const chunk of response.readableStreamBody!) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as T;
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) return null;
    throw err;
  }
}

export async function blobExists(
  containerFn: () => import("@azure/storage-blob").ContainerClient,
  path: string,
): Promise<boolean> {
  return containerFn().getBlobClient(path).exists();
}

export const writePublicJson = <T>(path: string, data: T) =>
  writeJson(getPublicContainer, path, data);
export const writePrivateJson = <T>(path: string, data: T) =>
  writeJson(getPrivateContainer, path, data);
export const readPublicJson = <T>(path: string) =>
  readJson<T>(getPublicContainer, path);
export const readPrivateJson = <T>(path: string) =>
  readJson<T>(getPrivateContainer, path);
export const publicBlobExists = (path: string) =>
  blobExists(getPublicContainer, path);
export const privateBlobExists = (path: string) =>
  blobExists(getPrivateContainer, path);

async function expectJson<T>(
  handlerName: string,
  req: Parameters<typeof invoke>[1],
  okStatuses: number[] = [200, 201],
): Promise<T> {
  const res: HttpResponseInit = await invoke(handlerName, req);
  if (!okStatuses.includes(res.status ?? 200)) {
    throw new Error(
      `${handlerName} returned ${res.status}: ${JSON.stringify(res.jsonBody)}`,
    );
  }
  return res.jsonBody as T;
}

async function expectOk(
  handlerName: string,
  req: Parameters<typeof invoke>[1],
  okStatuses: number[] = [200, 201, 202, 204],
): Promise<HttpResponseInit> {
  const res = await invoke(handlerName, req);
  if (!okStatuses.includes(res.status ?? 200)) {
    throw new Error(
      `${handlerName} returned ${res.status}: ${JSON.stringify(res.jsonBody)}`,
    );
  }
  return res;
}

interface BootstrapAdmin {
  user: User;
  token: string;
}

let bootstrapAdminMemo: BootstrapAdmin | null = null;

export async function bootstrapAdmin(): Promise<BootstrapAdmin> {
  if (bootstrapAdminMemo) return bootstrapAdminMemo;

  const adminId = randomUUID();
  const adminEmail = `seed-admin-${adminId.slice(0, 8)}@example.com`;
  const user: User = {
    id: adminId,
    email: adminEmail,
    roles: ["Admin"],
    pilotId: null,
    clubId: null,
    createdAt: new Date().toISOString(),
  };

  // Bootstrap exception: the auth API requires an existing admin to grant Admin,
  // so no handler can create this first user. Other raw fixture writes are limited
  // to the file-level allowlist above; the F2 oracle allowlists this exact call site.
  await writePrivateJson(`users/${adminId}.json`, user);
  bootstrapAdminMemo = { user, token: signAccessToken(adminId, adminEmail, 0) };
  return bootstrapAdminMemo;
}

async function adminRequest(options: Parameters<typeof makeRequest>[0] = {}) {
  const { user } = await bootstrapAdmin();
  return makeAuthRequest(user.id, user.email, options);
}

export interface SeedUserOptions {
  id?: string;
  email?: string;
  roles?: User["roles"];
  pilotId?: string | null;
  clubId?: string | null;
  password?: string;
  emailVerified?: boolean;
}

export async function makeUser(
  overrides: SeedUserOptions = {},
): Promise<{ user: User; credential: AuthCredential; password: string }> {
  const email = (overrides.email ?? `test-${randomUUID().slice(0, 8)}@example.com`).toLowerCase();
  const password = overrides.password ?? "TestPass123!";

  await expectOk(
    "authRegister",
    makeRequest({
      method: "POST",
      headers: { "x-forwarded-for": `${randomUUID()}.seed` },
      body: {
        email,
        password,
        acceptTsCs: true,
        acceptedTsCsVersion: 1,
      },
    }),
    [202],
  );

  if (overrides.emailVerified !== false) {
    const verifyUrl = getLastVerificationUrl();
    let token = verifyUrl ? new URL(verifyUrl).searchParams.get("token") : null;
    if (!token) {
      const index = (await readPrivateJson<UserIndex>("user-index.json")) ?? {};
      const pendingUserId = index[email];
      token = pendingUserId
        ? ((await readPrivateJson<{ token: string }>(`auth/verification-state/${pendingUserId}.json`))?.token ?? null)
        : null;
    }
    if (!token) throw new Error("authRegister did not send a verification URL");
    await expectOk(
      "authVerifyEmail",
      makeRequest({ method: "GET", query: { token } }),
      [200],
    );
  }
  clearSentEmails();

  const index = (await readPrivateJson<UserIndex>("user-index.json")) ?? {};
  const userId = index[email];
  if (!userId) throw new Error(`Registered user ${email} missing from user-index.json`);

  let user = await readPrivateJson<User>(`users/${userId}.json`);
  if (!user) throw new Error(`Registered user ${userId} missing users blob`);
  if (user.acceptedTsCsVersion !== undefined) {
    user = {
      ...user,
      acceptedTsCsAt: undefined,
      acceptedTsCsIp: undefined,
      acceptedTsCsVersion: undefined,
    };
    await writePrivateJson(`users/${userId}.json`, user);
  }

  if (
    overrides.roles !== undefined ||
    overrides.pilotId !== undefined ||
    overrides.clubId !== undefined
  ) {
    user = await expectJson<User>(
      "setUserRoles",
      await adminRequest({
        method: "PUT",
        params: { userId },
        body: {
          ...(overrides.roles !== undefined && { roles: overrides.roles }),
          ...(overrides.pilotId !== undefined && { pilotId: overrides.pilotId }),
          ...(overrides.clubId !== undefined && { clubId: overrides.clubId }),
        },
      }),
    );
  }

  const credential = await readPrivateJson<AuthCredential>(`auth/${userId}.json`);
  if (!credential) throw new Error(`Registered user ${userId} missing auth blob`);
  return { user, credential, password };
}

export interface SeedPilotOptions {
  id?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  clubId?: string;
  wingClass?: WingClass;
}

export async function makePilot(
  overrides: SeedPilotOptions = {},
): Promise<Pilot> {
  const firstName = overrides.firstName ?? "Test";
  const lastName = overrides.lastName ?? "Pilot";
  const currentClub = overrides.clubId
    ? { id: overrides.clubId, name: "Test Club" }
    : undefined;
  const createFirstName = firstName.trim() || "Test";
  const createLastName = lastName.trim() || "Pilot";

  const created = await expectJson<Pilot>(
    "createPilot",
    await adminRequest({
      method: "POST",
      body: {
        firstName: createFirstName,
        lastName: createLastName,
        email: overrides.email,
        wingClass: overrides.wingClass ?? "EN B",
        currentClub,
      },
    }),
  );

  const pilot: Pilot = {
    ...created,
    legacyId: created.legacyId,
    ...(overrides.id && { id: overrides.id }),
    person: {
      ...created.person,
      firstName,
      lastName,
      fullName: `${firstName} ${lastName}`,
    },
  };
  if (!overrides.id && firstName === createFirstName && lastName === createLastName) return created;
  await writePrivateJson(`pilots/${pilot.id}.json`, pilot);
  return pilot;
}

export interface SeedRoundOptions {
  id?: string;
  date?: string;
  status?: Round["status"];
  siteId?: string;
  siteName?: string;
  seasonYear?: number;
  organisingClubId?: string;
  organisingClubName?: string;
  teams?: Round["teams"];
}

const seededSeasons = new Set<number>();

async function ensureSeason(year: number): Promise<void> {
  if (seededSeasons.has(year)) return;
  const res = await invoke(
    "createSeason",
    await adminRequest({ method: "POST", body: { year, active: true } }),
  );
  if (![201, 409].includes(res.status ?? 200)) {
    throw new Error(`createSeason returned ${res.status}: ${JSON.stringify(res.jsonBody)}`);
  }
  seededSeasons.add(year);
}

async function transitionRound(id: string, status: RoundStatus): Promise<Round> {
  const order: RoundStatus[] = ["Proposed", "Confirmed", "BriefComplete", "Locked", "Complete"];
  const target = order.indexOf(status);
  if (target < 0 || status === "Proposed") {
    const round = await readPrivateJson<Round>(`rounds/${id}.json`);
    if (!round) throw new Error(`Round ${id} missing after createRound`);
    return round;
  }

  let latest: Round | null = null;
  const steps: Array<[RoundStatus, string]> = [
    ["Confirmed", "confirmRound"],
    ["BriefComplete", "briefCompleteRound"],
    ["Locked", "lockRound"],
    // completeRound 409s unless every Filled slot is accountedFor at this point — and the
    // lockRound step above resets them all to false, so they must be re-swept AFTER it.
    ["Complete", "completeRound"],
  ];
  for (const [stepStatus, handler] of steps) {
    if (order.indexOf(stepStatus) > target) break;
    latest = await expectJson<Round>(
      handler,
      await adminRequest({ method: "POST", params: { id } }),
    );
  }
  if (!latest) throw new Error(`No transition run for ${status}`);
  return latest;
}

export async function makeRound(
  overrides: SeedRoundOptions = {},
): Promise<Round> {
  const seasonYear = overrides.seasonYear ?? 2025;
  await ensureSeason(seasonYear);

  const site = await makeSite({
    id: overrides.siteId,
    name: overrides.siteName ?? "Test Site",
    clubId: overrides.organisingClubId,
  });
  let organisingClub: Club | undefined;
  if (overrides.organisingClubId) {
    organisingClub = await makeClub({
      id: overrides.organisingClubId,
      name: overrides.organisingClubName ?? "Test Club",
    });
  }

  let round = await expectJson<Round>(
    "createRound",
    await adminRequest({
      method: "POST",
      body: {
        date: overrides.date ?? "2025-06-15",
        siteId: site.id,
        seasonYear,
        organisingClubId: organisingClub?.id,
        maxTeams: 8,
        minimumScore: 0,
      },
    }),
  );

  if (overrides.id || overrides.teams) {
    const targetId = overrides.id ?? round.id;
    if (targetId !== round.id) {
      // createRound seeded the brief under the original id; relocate it so
      // brief-complete (which now requires an existing brief) finds it.
      const brief = await readPrivateJson<Record<string, unknown>>(`round-briefs/${round.id}.json`);
      if (brief) await writePrivateJson(`round-briefs/${targetId}.json`, { ...brief, roundId: targetId });
    }
    round = {
      ...round,
      id: targetId,
      ...(overrides.teams !== undefined && { teams: overrides.teams }),
    };
    await writePrivateJson(`rounds/${targetId}.json`, round);
  }

  return transitionRound(round.id, overrides.status ?? "Proposed");
}

export interface SeedClubOptions {
  id?: string;
  name?: string;
}

export async function makeClub(
  overrides: SeedClubOptions = {},
): Promise<Club> {
  const created = await expectJson<Club>(
    "createClub",
    await adminRequest({
      method: "POST",
      body: { name: overrides.name ?? "Test Club" },
    }),
  );
  if (!overrides.id || overrides.id === created.id) return created;
  const club: Club = { ...created, id: overrides.id };
  await writePrivateJson(`clubs/${club.id}.json`, club);
  return club;
}

export interface SeedSiteOptions {
  id?: string;
  name?: string;
  clubId?: string;
}

export async function makeSite(
  overrides: SeedSiteOptions = {},
): Promise<Site> {
  const created = await expectJson<Site>(
    "createSite",
    await adminRequest({
      method: "POST",
      body: {
        name: overrides.name ?? "Test Site",
        clubId: overrides.clubId ?? randomUUID(),
        status: "Active",
      },
    }),
  );
  if (!overrides.id || overrides.id === created.id) return created;
  const site: Site = { ...created, id: overrides.id };
  await writePrivateJson(`sites/${site.id}.json`, site);
  return site;
}

export interface SeedClubTeamOptions {
  id?: string;
  clubId?: string;
  clubName?: string;
  seasonYear?: number;
  teamName?: string;
}

export async function makeClubTeam(
  overrides: SeedClubTeamOptions = {},
): Promise<ClubTeam> {
  const club = overrides.clubId
    ? await makeClub({ id: overrides.clubId, name: overrides.clubName ?? "Test Club" })
    : await makeClub({ name: overrides.clubName ?? "Test Club" });
  const created = await expectJson<ClubTeam>(
    "createClubTeam",
    await adminRequest({
      method: "POST",
      body: {
        clubId: club.id,
        seasonYear: overrides.seasonYear ?? 2025,
        teamName: overrides.teamName ?? "Alpha",
      },
    }),
  );
  if (!overrides.id || overrides.id === created.id) return created;
  const team: ClubTeam = { ...created, id: overrides.id };
  await writePrivateJson(`club-teams/${team.id}.json`, team);
  return team;
}

export async function makeConfig(
  overrides: Partial<Config> = {},
): Promise<Config> {
  return expectJson<Config>(
    "updateConfig",
    await adminRequest({
      method: "PUT",
      body: overrides,
    }),
  );
}
