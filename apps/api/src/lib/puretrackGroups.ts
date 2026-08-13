// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from "crypto";
import type { PureTrackGroup, Round, Team } from "@bccweb/types";
import { writePrivateBlob } from "./blob.js";
import {
  authenticate,
  createGroup,
  deleteGroups,
  importPilots,
  PureTrackCreateResponseError,
  type BeforePureTrackOutbound,
  type PureTrackApiGroup,
  type PureTrackSession,
} from "./puretrackApi.js";
import { roundGroupName, teamGroupName } from "./puretrackNames.js";

const BASE_URL = "https://puretrack.io";

export function isPureTrackEnabled(): boolean {
  return process.env["PURETRACK_ENABLED"] !== "false";
}

export class PureTrackGroupOperationError extends Error {
  readonly name = "PureTrackGroupOperationError";

  constructor(
    public readonly cleanupIds: readonly number[],
    cause: unknown,
  ) {
    super("PureTrack group orchestration failed", { cause });
  }
}

async function writePureTrackGroupBlob(
  group: PureTrackApiGroup,
  pilotIds: string[],
  roundId: string,
  createdAt: string,
  options: { readonly teamId?: string; readonly callerUserId?: string },
): Promise<void> {
  const blobId = randomUUID();
  const record: PureTrackGroup = {
    id: blobId,
    name: group.name,
    slug: group.slug,
    pilotIds,
    roundId,
    createdAt,
    externalId: String(group.id),
    externalUrl: `${BASE_URL}/g/${group.slug}`,
    ...(options.teamId ? { teamId: options.teamId } : {}),
    ...(options.callerUserId ? { createdBy: options.callerUserId } : {}),
  };
  await writePrivateBlob(`puretrack-groups/${blobId}.json`, record);
}

export interface PureTrackRoundResult {
  readonly roundGroupId: number;
  readonly roundGroupName: string;
  readonly roundGroupSlug: string;
  readonly teams: Array<{
    readonly teamId: string;
    readonly groupId: number;
    readonly groupSlug: string;
  }>;
}

export interface CreatePureTrackGroupsOptions {
  readonly callerUserId?: string;
  readonly beforeOutbound?: BeforePureTrackOutbound;
  readonly session?: PureTrackSession;
}

type TeamImport = {
  readonly team: Team;
  readonly pureTrackIds: number[];
  readonly bccPilotIds: string[];
};

export async function createPureTrackGroups(
  round: Round,
  pilotPureTrackIds: Map<string, number>,
  options: CreatePureTrackGroupsOptions = {},
): Promise<PureTrackRoundResult | null> {
  if (!isPureTrackEnabled()) {
    console.log("[puretrack] skipped: PURETRACK_ENABLED=false");
    return null;
  }
  const beforeOutbound = options.beforeOutbound ?? (() => Promise.resolve());
  const teamResults: PureTrackRoundResult["teams"] = [];
  const allPureTrackIds: number[] = [];
  const allBccPilotIds: string[] = [];
  const teamImports: TeamImport[] = [];

  for (const team of round.teams) {
    const filledPilots = team.pilots.filter(
      (slot) => slot.status === "Filled" && slot.pilotId,
    );
    const teamPureTrackIds: number[] = [];
    const teamBccPilotIds: string[] = [];
    for (const slot of filledPilots) {
      const pilotId = slot.pilotId;
      if (!pilotId) continue;
      const pureTrackId = pilotPureTrackIds.get(pilotId);
      if (pureTrackId == null || pureTrackId === 0) {
        console.warn("[METRIC] puretrack.skip pilot lacks pureTrackId", { pilotId });
        continue;
      }
      teamPureTrackIds.push(pureTrackId);
      teamBccPilotIds.push(pilotId);
    }
    if (filledPilots.length === 0) continue;
    if (teamPureTrackIds.length > 0) {
      teamImports.push({ team, pureTrackIds: teamPureTrackIds, bccPilotIds: teamBccPilotIds });
    }
    for (const [index, pureTrackId] of teamPureTrackIds.entries()) {
      if (allPureTrackIds.includes(pureTrackId)) continue;
      const pilotId = teamBccPilotIds[index];
      if (!pilotId) continue;
      allPureTrackIds.push(pureTrackId);
      allBccPilotIds.push(pilotId);
    }
  }

  if (allPureTrackIds.length === 0) {
    console.warn("[METRIC] puretrack.skip pilot lacks pureTrackId", { roundId: round.id });
    return null;
  }
  const session = await sessionFor(round.id, beforeOutbound, options.session);
  const roundGroup = await createRoundGroup(round, beforeOutbound, session);
  const cleanupIds: number[] = [roundGroup.id];
  const now = new Date().toISOString();
  try {
    await writePureTrackGroupBlob(roundGroup, allBccPilotIds, round.id, now, {
      callerUserId: options.callerUserId,
    });
  } catch (cause: unknown) {
    await Promise.allSettled([deleteGroups(session, [roundGroup.id], beforeOutbound)]);
    throw new PureTrackGroupOperationError(cleanupIds, cause);
  }

  try {
    for (const item of teamImports) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const teamGroup = await createTeamGroup({
        round,
        team: item.team,
        beforeOutbound,
        session,
        cleanupIds,
      });
      cleanupIds.push(teamGroup.id);
      try {
        await writePureTrackGroupBlob(teamGroup, item.bccPilotIds, round.id, now, {
          teamId: item.team.id,
          callerUserId: options.callerUserId,
        });
      } catch (cause: unknown) {
        await Promise.allSettled([deleteGroups(session, [teamGroup.id], beforeOutbound)]);
        throw new PureTrackGroupOperationError(cleanupIds, cause);
      }
      teamResults.push({
        teamId: item.team.id,
        groupId: teamGroup.id,
        groupSlug: teamGroup.slug,
      });
      await importPilots(teamGroup.id, item.pureTrackIds, beforeOutbound, session);
    }
    await importPilots(roundGroup.id, allPureTrackIds, beforeOutbound, session);
  } catch (cause: unknown) {
    if (cause instanceof PureTrackGroupOperationError) throw cause;
    throw new PureTrackGroupOperationError(cleanupIds, cause);
  }
  return {
    roundGroupId: roundGroup.id,
    roundGroupName: roundGroup.name,
    roundGroupSlug: roundGroup.slug,
    teams: teamResults,
  };
}

async function sessionFor(
  roundId: string,
  beforeOutbound: BeforePureTrackOutbound,
  sharedSession: PureTrackSession | undefined,
): Promise<PureTrackSession> {
  try {
    return sharedSession ?? await authenticate(beforeOutbound);
  } catch (cause: unknown) {
    console.error("[METRIC] puretrack.create.failed", {
      roundId,
      reason: cause instanceof Error ? cause.message : String(cause),
    });
    throw cause;
  }
}

async function createRoundGroup(
  round: Round,
  beforeOutbound: BeforePureTrackOutbound,
  session: PureTrackSession,
): Promise<PureTrackApiGroup> {
  try {
    return await createGroup(roundGroupName(round.site.name, round.date), beforeOutbound, session);
  } catch (cause: unknown) {
    console.error("[METRIC] puretrack.create.failed", {
      roundId: round.id,
      type: "round-group",
      reason: cause instanceof Error ? cause.message : String(cause),
    });
    throw cause;
  }
}

async function createTeamGroup(
  input: {
    readonly round: Round;
    readonly team: Team;
    readonly beforeOutbound: BeforePureTrackOutbound;
    readonly session: PureTrackSession;
    readonly cleanupIds: number[];
  },
): Promise<PureTrackApiGroup> {
  try {
    return await createGroup(
      teamGroupName(input.round.date, input.team.teamName),
      input.beforeOutbound,
      input.session,
    );
  } catch (cause: unknown) {
    if (cause instanceof PureTrackCreateResponseError && cause.cleanupId !== undefined) {
      input.cleanupIds.push(cause.cleanupId);
    }
    console.error("[METRIC] puretrack.create.failed", {
      roundId: input.round.id,
      teamId: input.team.id,
      type: "team-group",
      reason: cause instanceof Error ? cause.message : String(cause),
    });
    throw cause;
  }
}
