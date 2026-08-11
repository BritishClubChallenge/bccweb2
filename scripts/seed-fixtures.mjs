#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * seed-fixtures.mjs
 *
 * Bulk deterministic fixture generator for local load/integration testing.
 * Writes directly to Azurite/Azure Blob Storage; does not call the HTTP API.
 */

import { ConfigSchema } from "@bccweb/schemas";
import {
  getPrivateContainer,
  getPublicContainer,
  preflightBlobContainerRead,
  precomputeBcryptHash,
  readJson,
  writeJson,
} from "./lib/blobSeed.mjs";
import {
  legacyFixtureRemainder,
  parseFixtureOwnership,
} from "./lib/fixtureOwnership.mjs";
import {
  cleanupFixturesTransaction,
  removePreparedMetadataForSeedRound,
} from "./lib/fixtureCleanupTransaction.mjs";
import {
  readCleanupState,
  withFixtureOperationLock,
  writeJsonDurably,
} from "./lib/fixtureOperation.mjs";
import {
  CLUB_COUNT,
  FIXTURE_MANIFEST_PATH,
  FIXTURE_PILOT_PASSWORD,
  PILOT_COUNT,
  SEASON_YEAR,
} from "./lib/loadTestConsts.mjs";
import {
  buildLoadTestManifest,
  validateLoadTestManifest,
} from "./lib/loadTestTopology.mjs";
import { buildFixturePilots } from "./lib/seedFixturePilots.mjs";
import {
  ACTIVE_WORDING_PATH,
  WORDING_PATH,
  activeWordingPointer,
  buildCanonicalSignToFlyWording,
} from "./lib/loadTestWording.mjs";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const CHUNK_SIZE = 50;
const SITE_NAMES = ["Site Alpha", "Site Bravo", "Site Charlie"];

async function inChunks(items, worker) {
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    await Promise.all(items.slice(i, i + CHUNK_SIZE).map(worker));
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function sortedByNameThenId(items) {
  return [...items].sort((a, b) =>
    String(a.name ?? "").localeCompare(String(b.name ?? "")) ||
    String(a.id ?? "").localeCompare(String(b.id ?? ""))
  );
}

function replaceOwnedRows(existing, fixtureRows, ownedIds) {
  const ownership = new Set(ownedIds);
  return [...asArray(existing).filter(({ id }) => !ownership.has(id)), ...fixtureRows];
}

function replaceOwnedIndexEntries(existing, fixtureEntries, ownedIds) {
  const ownership = new Set(ownedIds);
  return {
    ...Object.fromEntries(
      Object.entries(existing ?? {}).filter(([, id]) => !ownership.has(id))
    ),
    ...fixtureEntries,
  };
}

function buildManifest() {
  return buildLoadTestManifest({ seasonYear: SEASON_YEAR, siteNames: SITE_NAMES });
}

async function wipePriorFixtures(publicContainer, privateContainer, nextManifest) {
  if (!existsSync(FIXTURE_MANIFEST_PATH)) {
    const checkpoint = await readCleanupState();
    if (checkpoint) {
      await cleanupFixturesTransaction(publicContainer, privateContainer, {
        manifest: checkpoint.manifest,
        retainedManifest: checkpoint.retainedManifest,
      });
    }
    const currentOwnership = parseFixtureOwnership(nextManifest);
    const legacyRemainder = legacyFixtureRemainder(currentOwnership);
    await inChunks(
      [
        ...legacyRemainder.clubIds.map((id) => () =>
          privateContainer.getBlobClient(`clubs/${id}.json`).deleteIfExists()
        ),
        ...legacyRemainder.teamIds.map((id) => () =>
          privateContainer.getBlobClient(`club-teams/${id}.json`).deleteIfExists()
        ),
      ],
      (job) => job()
    );
    await removePreparedMetadataForSeedRound();
    return legacyRemainder;
  }

  const manifest = JSON.parse(await readFile(FIXTURE_MANIFEST_PATH, "utf8"));
  await cleanupFixturesTransaction(publicContainer, privateContainer, {
    manifest,
    retainedManifest: nextManifest,
  });
  return { clubIds: [], teamIds: [] };
}

async function patchConfig(privateContainer) {
  // Seed a COMPLETE, canonical new-shape Config straight from the single schema
  // source of truth. `ConfigSchema.parse({})` yields EVERY scoring field at its
  // legacy-correct default (the counts, taskMaxPoints 1000, plus the pilot /
  // wing / clubs-attending / min-distance factor tables), so a fresh read heals
  // NOTHING — no missing field is injected — and the seed can never drift from
  // the real Config shape (mirrors the DRY virgin fallback in roundsMutate.ts /
  // recompute.ts / roundRegistration.ts). The intentional dev-fixture overrides
  // below are all valid Config scalars, so the blob still heals to nothing.
  // Overwrites any prior config.json so the fixture state is deterministic.
  const config = {
    ...ConfigSchema.parse({}),
    // ── Dev-fixture overrides (deliberate deviations from legacy defaults) ──
    maxTeamsInClub: 3, // dev headroom (legacy default 2)
    // Load-bearing: the load-test packs LOADTEST_SLOTS_PER_TEAM (=10) pilots
    // into each of LOADTEST_TEAMS (=50) teams (500 total); canonical 9 would
    // 409 the 10th pilot per team — keep the dev override at 10.
    maxPilotsInTeam: 10,
    maxScoringPilotsInTeam: 5, // dev override (legacy default 6)
    flightDateValidationEnabled: false, // dev: accept past-/mis-dated fixture flights
  };
  await writeJson(privateContainer, "config.json", config);
  return config;
}

async function main() {
  const startedAt = performance.now();
  const manifest = buildManifest();
  validateLoadTestManifest(manifest, SEASON_YEAR);
  const publicContainer = getPublicContainer();
  const privateContainer = getPrivateContainer();
  await Promise.all([
    preflightBlobContainerRead(publicContainer),
    preflightBlobContainerRead(privateContainer),
  ]);
  await Promise.all([
    publicContainer.createIfNotExists({ access: "blob" }),
    privateContainer.createIfNotExists(),
  ]);

  const pilotPasswordHash = await precomputeBcryptHash(FIXTURE_PILOT_PASSWORD);
  const staleOwnership = await wipePriorFixtures(publicContainer, privateContainer, manifest);

  const now = new Date().toISOString();

  const siteSummaries = SITE_NAMES.map((name, index) => ({
    id: manifest.siteIds[index],
    name,
    status: "Active",
    clubId: manifest.clubIds[0],
  }));
  await inChunks(siteSummaries, (site) =>
    writeJson(privateContainer, `sites/${site.id}.json`, { ...site, createdAt: now, updatedAt: now })
  );

  const seasonSummary = { id: String(SEASON_YEAR), year: SEASON_YEAR, active: true };
  const existingSeason = await readJson(publicContainer, `seasons/${SEASON_YEAR}.json`);
  const season = {
    ...seasonSummary,
    name: `BCC ${SEASON_YEAR}`,
    startDate: `${SEASON_YEAR}-04-01`,
    endDate: `${SEASON_YEAR}-10-31`,
    rounds: asArray(existingSeason?.rounds),
    leagueTable: asArray(existingSeason?.leagueTable),
  };

  await patchConfig(privateContainer);
  await Promise.all([
    writeJson(privateContainer, WORDING_PATH, buildCanonicalSignToFlyWording(now)),
    writeJson(privateContainer, ACTIVE_WORDING_PATH, activeWordingPointer()),
  ]);

  const clubs = manifest.clubs.map(({ id, name }) => ({
      id,
      name,
      sites: [manifest.siteIds[0]],
      teams: [],
      createdAt: now,
      updatedAt: now,
    }));
  await inChunks(clubs, (club) => writeJson(privateContainer, `clubs/${club.id}.json`, club));

  const clubTeams = manifest.teams.map((team) => ({
      ...team,
      createdAt: now,
    }));
  await inChunks(clubTeams, (team) => writeJson(privateContainer, `club-teams/${team.id}.json`, team));

  const { pilots, userIndexEntries, pilotEmailIndexEntries } =
    buildFixturePilots({ manifest, now, pilotPasswordHash });

  const pilotWriteJobs = pilots.flatMap((pilot) => [
    () => writeJson(privateContainer, `pilots/${pilot.privatePilot.id}.json`, pilot.privatePilot),
    () => writeJson(privateContainer, `auth/${pilot.user.id}.json`, pilot.auth),
    () => writeJson(privateContainer, `users/${pilot.user.id}.json`, pilot.user),
  ]);
  await inChunks(pilotWriteJobs, (job) => job());

  // Preserves admin (T7) and any non-fixture user entries across wipe→reseed cycles.
  // Fixture entries always win on collision.
  const existingUserIndex = (await readJson(privateContainer, "user-index.json")) ?? {};
  await writeJson(
    privateContainer,
    "user-index.json",
    replaceOwnedIndexEntries(existingUserIndex, userIndexEntries, manifest.userIds)
  );

  const existingPilotEmailIndex = (await readJson(privateContainer, "pilot-email-index.json")) ?? {};
  await writeJson(
    privateContainer,
    "pilot-email-index.json",
    replaceOwnedIndexEntries(
      existingPilotEmailIndex,
      pilotEmailIndexEntries,
      manifest.pilotIds
    )
  );

  const [existingPilots, existingClubs, existingTeams, existingSites, existingSeasons] =
    await Promise.all([
      readJson(publicContainer, "pilots.json"),
      readJson(publicContainer, "clubs.json"),
      readJson(publicContainer, "club-teams.json"),
      readJson(publicContainer, "sites.json"),
      readJson(publicContainer, "seasons.json"),
    ]);

  await Promise.all([
    writeJson(publicContainer, "pilots.json", sortedByNameThenId(replaceOwnedRows(existingPilots, pilots.map((p) => p.summary), manifest.pilotIds))),
    writeJson(publicContainer, "clubs.json", sortedByNameThenId(replaceOwnedRows(existingClubs, clubs.map(({ id, name }) => ({ id, name })), [...manifest.clubIds, ...staleOwnership.clubIds]))),
    writeJson(publicContainer, "club-teams.json", replaceOwnedRows(existingTeams, clubTeams.map(({ id, clubId, clubName, seasonYear, teamName }) => ({ id, clubId, clubName, seasonYear, teamName })), [...manifest.teamIds, ...staleOwnership.teamIds]).sort((a, b) => {
      if (b.seasonYear !== a.seasonYear) return b.seasonYear - a.seasonYear;
      if (a.clubName !== b.clubName) return a.clubName.localeCompare(b.clubName);
      return a.teamName.localeCompare(b.teamName);
    })),
    writeJson(publicContainer, "sites.json", sortedByNameThenId(replaceOwnedRows(existingSites, siteSummaries, manifest.siteIds))),
    writeJson(publicContainer, "seasons.json", [...asArray(existingSeasons).filter(({ year }) => year !== SEASON_YEAR), seasonSummary]),
    writeJson(publicContainer, `seasons/${SEASON_YEAR}.json`, season),
  ]);

  await writeJsonDurably(FIXTURE_MANIFEST_PATH, manifest);

  const elapsedSeconds = ((performance.now() - startedAt) / 1000).toFixed(2);
  process.stderr.write(
    `[seed-fixtures] OK: ${PILOT_COUNT} pilots / ${CLUB_COUNT} clubs / ${clubTeams.length} teams / ${siteSummaries.length} sites / season ${SEASON_YEAR} (${elapsedSeconds}s)\n`
  );
}

withFixtureOperationLock(main).catch((err) => {
  process.stderr.write(`seed-fixtures: ${err?.stack ?? err?.message ?? String(err)}\n`);
  process.exit(1);
});
