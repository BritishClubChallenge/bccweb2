// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const phaseGates = new Map([
  ["artifact-first", { parent: "absent", useIdentityStorage: false, allowSharedKeyAccess: true }],
  ["identity-apply", { parent: "artifact-first", useIdentityStorage: true, allowSharedKeyAccess: true }],
  ["shared-key-off", { parent: "identity-apply", useIdentityStorage: true, allowSharedKeyAccess: false }],
  ["rollback-key-on", { parent: "shared-key-off", useIdentityStorage: true, allowSharedKeyAccess: true }],
  ["rollback-connection-string", { parent: "rollback-key-on", useIdentityStorage: false, allowSharedKeyAccess: true }],
]);

function parseBooleanAssignment(contents, name) {
  const assignment = new RegExp(`^\\s*${name}\\s*=\\s*([^#\\r\\n]+?)(?:\\s*#.*)?$`, "gmu");
  const matches = [...contents.matchAll(assignment)];
  if (matches.length !== 1) {
    throw new Error(`${name} must appear exactly once in staging tfvars`);
  }
  const value = matches[0][1]?.trim();
  if (value !== "true" && value !== "false") {
    throw new Error(`${name} must be a literal boolean`);
  }
  return value === "true";
}

export function validateRolloutTransition(parentPhase, targetPhase, tfvarsContents) {
  const gate = phaseGates.get(targetPhase);
  if (!gate) throw new Error(`Unknown target phase: ${targetPhase}`);
  if (parentPhase !== "absent" && !phaseGates.has(parentPhase)) {
    throw new Error(`Unknown parent phase: ${parentPhase}`);
  }
  if (parentPhase !== gate.parent) {
    throw new Error(`Rollout transition is not allowed: ${parentPhase} -> ${targetPhase}`);
  }

  const useIdentityStorage = parseBooleanAssignment(tfvarsContents, "use_identity_storage");
  const allowSharedKeyAccess = parseBooleanAssignment(tfvarsContents, "allow_shared_key_access");
  if (
    useIdentityStorage !== gate.useIdentityStorage ||
    allowSharedKeyAccess !== gate.allowSharedKeyAccess
  ) {
    throw new Error(
      `Terraform gate mismatch for ${targetPhase}: expected ` +
        `use_identity_storage=${gate.useIdentityStorage}, ` +
        `allow_shared_key_access=${gate.allowSharedKeyAccess}`,
    );
  }

  return { parentPhase, targetPhase, useIdentityStorage, allowSharedKeyAccess };
}

async function main() {
  const [parentPhase, targetPhase, tfvarsPath, ...extra] = process.argv.slice(2);
  if (!parentPhase || !targetPhase || !tfvarsPath || extra.length > 0) {
    throw new Error(
      "Usage: node scripts/ci/rollout-transition-guard.mjs <parent-phase> <target-phase> <staging.tfvars>",
    );
  }
  const tfvarsContents = await readFile(tfvarsPath, "utf8");
  validateRolloutTransition(parentPhase, targetPhase, tfvarsContents);
  console.log(`[PASS] rollout transition ${parentPhase} -> ${targetPhase}`);
}

const entryPath = process.argv[1];
if (entryPath && resolve(entryPath) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[FAIL] ${error instanceof Error ? error.message : "Unknown rollout transition error"}`);
    process.exitCode = 1;
  });
}
