// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "vitest";

interface MigrateModule {
  legacyMigratedSignature(input: {
    roundId: string;
    teamId: string;
    place: number;
    pilotId: string;
    stableKey?: string;
    legacyId?: number;
  }): unknown;
  legacySignaturePath(roundId: string, teamId: string, place: number, pilotId: string): string;
}

async function loadMigrationHelpers(): Promise<MigrateModule> {
  const modulePath = new URL("../../../../scripts/migrate/transforms.mjs", import.meta.url).href;
  return import(modulePath) as Promise<MigrateModule>;
}

describe("legacy SignToFly migration", () => {
  it("legacy SignToFly=true → Signature.source === 'legacy-migrated' AND audit fields all null", async () => {
    const { legacyMigratedSignature, legacySignaturePath } = await loadMigrationHelpers();

    const sig = legacyMigratedSignature({
      roundId: "round-1",
      teamId: "team-1",
      place: 4,
      pilotId: "pilot-1",
      stableKey: "round-1-team-1-4",
    }) as Record<string, unknown>;

    expect(legacySignaturePath("round-1", "team-1", 4, "pilot-1")).toBe("signatures/round-1/team-1-4-pilot-1-vlegacy.json");
    expect(sig.source).toBe("legacy-migrated");
    expect(sig.signedAt).toBeNull();
    expect(sig.ip).toBeNull();
    expect(sig.userAgent).toBeNull();
    expect(sig.briefVersion).toBeNull();
    expect(sig.wordingVersion).toBeNull();
    expect(sig.briefHash).toBeNull();
    expect(sig.wordingHash).toBeNull();
  });
});
