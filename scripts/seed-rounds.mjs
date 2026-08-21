#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/** Seed four canonical, snapshotted browsing rounds through the production API. */

import { existsSync, readFileSync } from "node:fs";
import { cleanupOwnedRoundIds } from "./lib/loadTestRoundCleanup.mjs";
import { createLoadTestApi, loginLoadTestUser } from "./lib/loadTestApi.mjs";
import { resolveAdminPassword } from "./lib/devCredentials.mjs";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD_OVERRIDE,
  BCC_API_BASE_URL,
  FIXTURE_MANIFEST_PATH,
  FIXTURE_PILOT_PASSWORD,
  SEASON_YEAR,
} from "./lib/loadTestConsts.mjs";
import {
  appendSeedRoundId,
  assertSeedRoundTarget,
  readLoadTestRoundState,
  replaceSeedRoundIds,
  writeJsonAtomically,
} from "./lib/loadTestRoundState.mjs";
import { loadTestTargetIdentity } from "./lib/loadTestTargetIdentity.mjs";
import { validateLoadTestManifest } from "./lib/loadTestTopology.mjs";

const TARGET_STATUSES = ["Proposed", "Confirmed", "BriefComplete", "Locked"];
const DATE_OFFSETS_DAYS = [7, 14, 21, 28];
const CLUBS_PER_ROUND = 4;
const PILOTS_PER_TEAM = 3;
const SETUP_DEADLINE_MS = 15 * 60 * 1_000;
const SEED_TARGET = loadTestTargetIdentity(BCC_API_BASE_URL);

function fail(message) {
  throw new Error(`[seed-rounds] ${message}`);
}

function isoDate(offsetDays) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function selectedTeamsAndPilots(manifest) {
  const teams = manifest.clubs.slice(0, CLUBS_PER_ROUND).map((club) => {
    const team = manifest.teams.find(
      (candidate) => candidate.clubId === club.id && candidate.teamName.endsWith(" Team A"),
    );
    if (!team) fail(`missing canonical Team A for ${club.name}`);
    const pilots = manifest.pilots
      .filter((pilot) => pilot.clubTeamId === team.id)
      .sort((left, right) => left.teamLocalRank - right.teamLocalRank)
      .slice(0, PILOTS_PER_TEAM);
    if (pilots.length !== PILOTS_PER_TEAM) fail(`missing pilots for ${team.teamName}`);
    return { team, pilots };
  });
  return { teams, pilots: teams.flatMap(({ pilots }) => pilots) };
}

async function persistSeedOwnership(manifest, roundId) {
  await appendSeedRoundId(roundId, SEED_TARGET);
  const roundIds = Array.isArray(manifest.roundIds) ? manifest.roundIds : [];
  if (!roundIds.includes(roundId)) roundIds.push(roundId);
  manifest.roundIds = roundIds;
  await writeJsonAtomically(FIXTURE_MANIFEST_PATH, manifest);
}

async function replacePriorRounds(manifest) {
  const state = await readLoadTestRoundState();
  assertSeedRoundTarget(state, SEED_TARGET);
  const manifestIds = Array.isArray(manifest.roundIds) ? manifest.roundIds : [];
  const unprovenManifestId = manifestIds.find((roundId) => !state.seedRoundIds.includes(roundId));
  if (unprovenManifestId) fail("manifest round is not present in target-bound seed ownership");
  const priorIds = [...new Set([...state.seedRoundIds, ...manifestIds])];
  await cleanupOwnedRoundIds(priorIds, { seasonYears: [manifest.seasonYear] });
  await replaceSeedRoundIds([], SEED_TARGET);
  manifest.roundIds = [];
  await writeJsonAtomically(FIXTURE_MANIFEST_PATH, manifest);
}

// Seed the sign-to-fly signature for every Filled slot of the round's teams via
// the coord sign-override endpoint, so the lock gate (which blocks locks on any
// unsigned Filled slot at the current brief version) can pass. The script knows
// the team IDs and Filled pilots from the registration loop above — no extra API
// read is needed. The fixed reason satisfies the endpoint's ≥20-char rule.
const SIGN_OVERRIDE_REASON = "Seed script: browsing-data signature for locked fixture";

function explainHttpError(err) {
  const status = err?.status ?? "unknown";
  const body = err?.body ?? err?.message ?? String(err);
  return `HTTP ${status} ${body}`;
}

async function signFilledSlots(callApi, adminToken, roundId, registeredTeams) {
  for (const { teamId, teamName, pilots } of registeredTeams) {
    for (let placeIndex = 0; placeIndex < pilots.length; placeIndex += 1) {
      const place = placeIndex + 1;
      const pilot = pilots[placeIndex];
      const path = `/api/rounds/${roundId}/teams/${teamId}/pilots/${place}/sign-override`;
      try {
        await callApi("POST", path, {
          token: adminToken,
          body: { reason: SIGN_OVERRIDE_REASON, onBehalfOfPilotId: pilot.id },
        });
      } catch (err) {
        fail(
          `sign-override failed round=${roundId} team=${teamName} place=${place} pilot=${pilot.id}: ${explainHttpError(err)}`,
        );
      }
    }
  }
}

async function transitionRound(callApi, token, roundId, targetStatus) {
  if (targetStatus !== "Proposed") {
    await callApi("POST", `/api/rounds/${roundId}/confirm`, { token, body: {} });
  }
  if (targetStatus === "BriefComplete" || targetStatus === "Locked") {
    await callApi("POST", `/api/rounds/${roundId}/brief-complete`, { token, body: {} });
  }
}

async function lockRound(callApi, token, roundId) {
  try {
    await callApi("POST", `/api/rounds/${roundId}/lock`, { token, body: {} });
  } catch (err) {
    fail(`lock failed for round ${roundId}: ${explainHttpError(err)}`);
  }
}

async function seedRound(callApi, manifest, adminToken, pilotTokens, selected, statusIndex) {
  const targetStatus = TARGET_STATUSES[statusIndex];
  const created = await callApi("POST", "/api/rounds", {
    token: adminToken,
    body: {
      date: isoDate(DATE_OFFSETS_DAYS[statusIndex]),
      siteId: manifest.siteIds[0],
      seasonYear: manifest.seasonYear,
      organisingClubId: selected.teams[0].team.clubId,
    },
  });
  if (typeof created?.id !== "string" || created.id.length === 0) fail("createRound response missing id");
  const roundId = created.id;
  await persistSeedOwnership(manifest, roundId);

  const registeredTeams = [];
  for (const { team, pilots } of selected.teams) {
    const round = await callApi("POST", `/api/rounds/${roundId}/teams`, {
      token: adminToken,
      body: { clubId: team.clubId, teamName: team.teamName },
    });
    const added = round?.teams?.find(
      (candidate) => candidate.club?.id === team.clubId && candidate.teamName === team.teamName,
    );
    if (typeof added?.id !== "string") fail(`team ${team.teamName} missing from API response`);
    for (const pilot of pilots) {
      await callApi("POST", `/api/rounds/${roundId}/register-self`, {
        token: pilotTokens.get(pilot.id),
        body: { teamId: added.id },
      });
    }
    registeredTeams.push({ teamId: added.id, teamName: team.teamName, pilots });
  }
  if (targetStatus === "Locked") {
    // The sign-override endpoint requires BriefComplete; advance to that, then
    // sign every Filled slot, then lock. Doing sign before confirm/brief leaves
    // the round in Proposed and the gate then 409s on the sign call.
    await transitionRound(callApi, adminToken, roundId, "BriefComplete");
    await signFilledSlots(callApi, adminToken, roundId, registeredTeams);
    await lockRound(callApi, adminToken, roundId);
    return;
  }
  await transitionRound(callApi, adminToken, roundId, targetStatus);
}

async function main() {
  if (!existsSync(FIXTURE_MANIFEST_PATH)) fail("run 'make seed' first");
  const manifest = JSON.parse(readFileSync(FIXTURE_MANIFEST_PATH, "utf8"));
  validateLoadTestManifest(manifest, SEASON_YEAR);
  if (!Array.isArray(manifest.siteIds) || manifest.siteIds.length === 0) fail("canonical manifest has no siteIds");
  const selected = selectedTeamsAndPilots(manifest);
  const adminPassword = resolveAdminPassword(ADMIN_PASSWORD_OVERRIDE);
  await replacePriorRounds(manifest);

  const callApi = createLoadTestApi({
    baseUrl: BCC_API_BASE_URL,
    deadlineMs: Date.now() + SETUP_DEADLINE_MS,
  });
  const adminToken = await loginLoadTestUser(callApi, {
    email: ADMIN_EMAIL,
    password: adminPassword,
  });
  const pilotTokens = new Map();
  for (const [index, pilot] of selected.pilots.entries()) {
    // Azure supplies `client-ip`; local Functions falls back to the right-most XFF hop.
    const headers = BCC_API_BASE_URL.startsWith("http://localhost") || BCC_API_BASE_URL.startsWith("http://127.")
      ? { "x-forwarded-for": `127.77.0.${index + 1}` }
      : {};
    const token = await loginLoadTestUser(callApi, {
      email: pilot.email,
      password: FIXTURE_PILOT_PASSWORD,
    }, headers);
    pilotTokens.set(pilot.id, token);
    console.error(`[seed-rounds] authenticated synthetic pilot ${pilot.email}`);
  }
  for (let statusIndex = 0; statusIndex < TARGET_STATUSES.length; statusIndex += 1) {
    await seedRound(callApi, manifest, adminToken, pilotTokens, selected, statusIndex);
  }
  console.error(`[seed-rounds] OK: 4 rounds (${TARGET_STATUSES.join("/")})`);
}

main().catch((error) => {
  console.error(error?.stack ?? error?.message ?? String(error));
  process.exitCode = 1;
});
