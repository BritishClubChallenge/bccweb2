// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Pins the single sign-to-fly resolution (#279): the redundant modules are
// gone, no rival rule symbols survive in production source, every blob
// listing stays inside ledger.ts, and the four consumers import only
// resolution.js. Source-reading style follows
// functions/__tests__/roundWriteContract.test.ts.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, "..", "..", "..");
const SIGN_TO_FLY_DIR = path.resolve(HERE, "..");

/** Relative (to apps/api/src) paths of every non-test .ts file. */
async function listProductionSources(): Promise<string[]> {
  const entries = await fs.readdir(SRC_ROOT, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.parentPath.includes("__tests__"),
    )
    .map((entry) => path.relative(SRC_ROOT, path.join(entry.parentPath, entry.name)));
}

async function readSrc(relPath: string): Promise<string> {
  return fs.readFile(path.resolve(SRC_ROOT, relPath), "utf8");
}

/** Call sites of `callee(` outside its own defining file. */
async function callSitesOf(
  callee: string,
  definingFile: string,
): Promise<{ file: string; count: number }[]> {
  const sources = await listProductionSources();
  const sites: { file: string; count: number }[] = [];
  for (const rel of sources) {
    if (rel === definingFile) continue;
    const src = await readSrc(rel);
    const count = src.split(`${callee}(`).length - 1;
    if (count > 0) sites.push({ file: rel, count });
  }
  return sites;
}

describe("sign-to-fly resolution contract", () => {
  it("the superseded modules are deleted", async () => {
    for (const gone of ["completeness.ts", "invalidate.ts", "slotSignatureVersions.ts"]) {
      await expect(
        fs.stat(path.join(SIGN_TO_FLY_DIR, gone)),
        `${gone} must not exist`,
      ).rejects.toThrow();
    }
  });

  it("no production source names a removed sign-to-fly symbol", async () => {
    const FORBIDDEN = [
      "getLatestSignature",
      "briefVersionFromPath",
      "latestSignedVersions",
      "materializeSignToFly",
      "findUnsignedSlots",
      "invalidatePriorSignToFlyFlags",
      "isSignedAtVersion",
      "isSupersededAtVersion",
      "slotKey(",
    ];
    const sources = await listProductionSources();
    const offenders: string[] = [];
    for (const rel of sources) {
      const src = await readSrc(rel);
      for (const token of FORBIDDEN) {
        if (src.includes(token)) offenders.push(`${rel}: ${token}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("signature-ledger listBlobsFlat( stays inside signTofly/ledger.ts", async () => {
    // Scoped to the signature listing: wording.ts legitimately lists its own
    // wording/ prefix (one of blob.ts's documented raw-container seams) and is
    // not a signature ledger reader.
    const entries = await fs.readdir(SIGN_TO_FLY_DIR, { withFileTypes: true });
    const offenders: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const src = await fs.readFile(path.join(SIGN_TO_FLY_DIR, entry.name), "utf8");
      if (entry.name === "ledger.ts" || entry.name === "wording.ts") continue;
      if (src.includes("listBlobsFlat(")) offenders.push(entry.name);
    }
    expect(offenders).toEqual([]);
  });

  it("listSignaturesForRound( is called only by resolution.ts and functions/signatures.ts", async () => {
    const sites = await callSitesOf("listSignaturesForRound", "lib/signTofly/ledger.ts");
    expect(sites.sort((a, b) => a.file.localeCompare(b.file))).toEqual([
      { file: "functions/signatures.ts", count: 1 },
      { file: "lib/signTofly/resolution.ts", count: 1 },
    ]);
  });

  it("listSignaturesForOccupancy( is called only by resolution.ts", async () => {
    const sites = await callSitesOf("listSignaturesForOccupancy", "lib/signTofly/ledger.ts");
    expect(sites).toEqual([{ file: "lib/signTofly/resolution.ts", count: 1 }]);
  });

  it("roundsMutate.ts imports only resolution.js and briefVersion.js from signTofly", async () => {
    const src = await readSrc("functions/roundsMutate.ts");
    const imports = [
      ...src.matchAll(/from "\.\.\/lib\/signTofly\/([^"]+)"/g),
    ].map((m) => m[1]);
    expect(imports.sort()).toEqual(["briefVersion.js", "resolution.js"]);
  });

  it("reflect.ts and roundUnregistration.ts import resolution.js", async () => {
    const reflect = await readSrc("lib/signTofly/reflect.ts");
    const unregister = await readSrc("functions/roundUnregistration.ts");
    expect(reflect).toContain('from "./resolution.js"');
    expect(unregister).toContain('from "../lib/signTofly/resolution.js"');
  });
});
