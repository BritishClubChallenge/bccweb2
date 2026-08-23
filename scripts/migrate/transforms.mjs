// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
// Migration transforms extracted from migrate.mjs. No SQL-driver (mssql) or uuid-package dependency, so this module is safe to import from any test context without installing the migrate package's own deps.
// Note: manufacturerFromLegacyRow / legacyMigratedSignature call getOrCreateUuid(), which may read/write .migration-state/id-map.json — i.e. these two are not strictly side-effect-free.
import { getOrCreateUuid } from "./id-map.mjs";

export const LEGACY_SIGNATURE_USER_ID = "legacy-import";

export function briefImageBlobFromLegacy(image) {
  if (image == null) return null;
  if (Buffer.isBuffer(image)) return image.length > 0 ? image : null;
  if (image instanceof Uint8Array) {
    const bytes = Buffer.from(image);
    return bytes.length > 0 ? bytes : null;
  }
  if (typeof image === "string" && image.trim().length > 0) {
    const bytes = Buffer.from(image, "base64");
    return bytes.length > 0 ? bytes : null;
  }
  return null;
}

export function briefImagePath(roundId, imageNumber = 1) {
  return `round-briefs/${roundId}/image-${imageNumber}.png`;
}

export function normalizeWebsiteUrl(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseFrequencyMhz(raw) {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const frequencyMhz = Number(trimmed);
  return Number.isFinite(frequencyMhz) && frequencyMhz > 0 && frequencyMhz < 1000 ? frequencyMhz : undefined;
}

export function ensureNonEmpty(value, fallback) {
  const trimmed = value == null ? "" : String(value).trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export function pilotSummaryFromMigration({ id, legacyId, name, currentSeasonClub, rating }) {
  return {
    id,
    legacyId,
    name,
    ...(currentSeasonClub ? { clubId: currentSeasonClub.clubId } : {}),
    rating,
  };
}

export function assertSeasonYear(raw) {
  const year = Number(raw);
  if (!Number.isInteger(year) || year < 2000 || year > 9999) {
    throw new Error(`Season year out of range: ${raw} — fix the source data`);
  }
  return year;
}

export function manufacturerFromLegacyRow(r) {
  const websiteUrl = normalizeWebsiteUrl(r.WebsiteUrl);
  return {
    id: getOrCreateUuid("manufacturer", r.ID),
    legacyId: r.ID,
    name: r.Name,
    ...(websiteUrl ? { websiteUrl } : {}),
  };
}

export function legacySignaturePath(roundId, teamId, place, pilotId) {
  return `signatures/${roundId}/${teamId}-${place}-${pilotId}-vlegacy.json`;
}

export function legacyMigratedSignature({ roundId, teamId, place, pilotId, stableKey, legacyId }) {
  return {
    id: getOrCreateUuid("signature", stableKey ?? `${roundId}-${teamId}-${place}`),
    roundId,
    teamId,
    place,
    pilotId,
    userId: LEGACY_SIGNATURE_USER_ID,
    signedAt: null,
    briefVersion: null,
    briefHash: null,
    wordingVersion: null,
    wordingHash: null,
    ip: null,
    userAgent: null,
    source: "legacy-migrated",
    ...(legacyId != null ? { legacyId } : {}),
  };
}
