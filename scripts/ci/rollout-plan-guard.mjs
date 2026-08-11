// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import {
  assertFunctionContract,
  assertRoleContract,
  roleNames,
} from "./rollout-plan-contracts.mjs";

const terraformPhases = new Set([
  "identity-apply",
  "shared-key-off",
  "rollback-key-on",
  "rollback-connection-string",
]);

const storageAddresses = new Set([
  "module.stamp.azapi_resource.storage_runtime",
  "module.stamp.azapi_resource.storage_data",
]);

const roleAddresses = new Set(roleNames.flatMap((name) => [
  `module.stamp.random_uuid.${name}[0]`,
  `module.stamp.azapi_resource.${name}_role[0]`,
]));

const keyForgetAddresses = new Set([
  "module.stamp.azapi_resource_action.storage_runtime_keys",
  "module.stamp.azapi_resource_action.storage_data_keys",
]);

const legacyKeyAddresses = new Set([
  "module.stamp.azapi_resource_action.storage_runtime_keys_legacy[0]",
  "module.stamp.azapi_resource_action.storage_data_keys_legacy[0]",
]);

function cloneWithoutComputed(value) {
  if (value === null || typeof value !== "object") return value;
  const clone = structuredClone(value);
  delete clone.id;
  delete clone.output;
  return clone;
}

function removePath(value, path) {
  let cursor = value;
  for (const part of path.slice(0, -1)) {
    if (cursor === null || typeof cursor !== "object") return;
    cursor = cursor[part];
  }
  if (cursor !== null && typeof cursor === "object") {
    delete cursor[path.at(-1)];
  }
}

function assertOnlyPathsChanged(resourceChange, paths, description) {
  const before = cloneWithoutComputed(resourceChange.change.before);
  const after = cloneWithoutComputed(resourceChange.change.after);
  if (isDeepStrictEqual(before, after)) {
    throw new Error(`${resourceChange.address} update contains no ${description} change`);
  }
  for (const path of paths) {
    removePath(before, path);
    removePath(after, path);
  }
  if (!isDeepStrictEqual(before, after)) {
    throw new Error(`${resourceChange.address} changes properties outside ${description}`);
  }
}

function resourceValues(resourceChange) {
  return [resourceChange.change.before, resourceChange.change.after].filter(
    (value) => value !== null && typeof value === "object",
  );
}

function stringsIn(value) {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  return Object.values(value).flatMap(stringsIn);
}

function assertStagingResourceNames(resourceChange) {
  for (const value of resourceValues(resourceChange)) {
    for (const candidate of stringsIn(value)) {
      const names = candidate.match(/(?:stbccweb[a-z0-9]+|(?:func|id|asp)-bccweb-[a-z0-9-]+)/gu) ?? [];
      for (const name of names) {
        if (!name.includes("staging")) {
          throw new Error(`${resourceChange.address} contains a non-staging resource name: ${name}`);
        }
      }
    }
  }
}

function assertStoragePolicyUpdate(resourceChange, phase) {
  assertOnlyPathsChanged(
    resourceChange,
    [["body", "properties", "allowSharedKeyAccess"]],
    "allowSharedKeyAccess",
  );
  const expected = phase !== "shared-key-off";
  const actual = resourceChange.change.after?.body?.properties?.allowSharedKeyAccess;
  if (actual !== expected) {
    throw new Error(
      `${resourceChange.address} allowSharedKeyAccess must be ${expected} during ${phase}`,
    );
  }
}

function assertKeyAction(resourceChange, phase) {
  const actions = resourceChange.change.actions;
  if (keyForgetAddresses.has(resourceChange.address)) {
    if (phase !== "identity-apply") {
      throw new Error(`${resourceChange.address} forget is only permitted during identity-apply`);
    }
    if (!isDeepStrictEqual(actions, ["forget"])) {
      throw new Error(`${resourceChange.address} must be a state-only forget`);
    }
    return;
  }
  if (phase !== "rollback-connection-string") {
    throw new Error(`${resourceChange.address} create is only permitted during rollback-connection-string`);
  }
  if (!isDeepStrictEqual(actions, ["create"])) {
    throw new Error(`${resourceChange.address} must be a create`);
  }
  const after = resourceChange.change.after;
  if (after?.action !== "listKeys") {
    throw new Error(`${resourceChange.address} must use the listKeys action`);
  }
}

function classifyChange(resourceChange, phase, identity) {
  const actions = resourceChange.change?.actions;
  if (!Array.isArray(actions)) {
    throw new Error(`${resourceChange.address ?? "unknown address"} has no Terraform actions`);
  }
  if (actions.includes("delete")) {
    throw new Error(`${resourceChange.address} attempts a resource delete or replace`);
  }
  if (isDeepStrictEqual(actions, ["no-op"])) return false;
  if (isDeepStrictEqual(actions, ["read"])) {
    throw new Error(`${resourceChange.address} contains a deferred read outside the rollout surfaces`);
  }

  assertStagingResourceNames(resourceChange);
  if (storageAddresses.has(resourceChange.address)) {
    if (!isDeepStrictEqual(actions, ["update"])) {
      throw new Error(`${resourceChange.address} storage policy surface only permits update`);
    }
    assertStoragePolicyUpdate(resourceChange, phase);
    return true;
  }
  if (resourceChange.address === "module.stamp.azapi_resource.function_app") {
    if (!isDeepStrictEqual(actions, ["update"])) {
      throw new Error(`${resourceChange.address} function surface only permits update`);
    }
    assertFunctionContract(resourceChange, phase, identity, assertOnlyPathsChanged);
    return true;
  }
  if (roleAddresses.has(resourceChange.address)) {
    assertRoleContract(resourceChange, identity);
    return true;
  }
  if (keyForgetAddresses.has(resourceChange.address) || legacyKeyAddresses.has(resourceChange.address)) {
    assertKeyAction(resourceChange, phase);
    return true;
  }
  throw new Error(`${resourceChange.address} address is not permitted by the staging rollout guard`);
}

export function classifyRolloutPlan(plan, phase) {
  if (!terraformPhases.has(phase)) throw new Error(`Unknown Terraform rollout phase: ${phase}`);
  if (plan === null || typeof plan !== "object" || !Array.isArray(plan.resource_changes)) {
    throw new Error("Terraform plan JSON must contain resource_changes");
  }
  const identityChange = plan.resource_changes.find(
    ({ address }) => address === "module.stamp.azapi_resource.fn_umi",
  );
  const identityValue = identityChange?.change?.after ?? identityChange?.change?.before;
  const functionChange = plan.resource_changes.find(
    ({ address }) => address === "module.stamp.azapi_resource.function_app",
  );
  const authentication = functionChange?.change?.after?.body?.properties
    ?.functionAppConfig?.deployment?.storage?.authentication;
  const identity = {
    id: identityValue?.id ?? authentication?.userAssignedIdentityResourceId,
    clientId: identityValue?.output?.properties?.clientId,
    principalId: identityValue?.output?.properties?.principalId,
  };
  const needsFunctionPrincipal = plan.resource_changes.some(
    ({ address }) => address?.startsWith("module.stamp.azapi_resource.fn_") && address.endsWith("_role[0]"),
  );
  if (needsFunctionPrincipal && !identity.principalId) {
    throw new Error("Terraform plan must contain the staging Function identity values");
  }
  if (
    identity.id &&
    !identity.id.endsWith(
      "/resourceGroups/stamp-staging/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-bccweb-staging-fn",
    )
  ) {
    throw new Error("Terraform plan contains the wrong staging Function identity resource ID");
  }
  let approvedChanges = 0;
  for (const resourceChange of plan.resource_changes) {
    if (classifyChange(resourceChange, phase, identity)) approvedChanges += 1;
  }
  return { approvedChanges, phase };
}

async function main() {
  const [planPath, phase, ...extra] = process.argv.slice(2);
  if (!planPath || !phase || extra.length > 0) {
    throw new Error("Usage: node scripts/ci/rollout-plan-guard.mjs <plan.json> <phase>");
  }
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  const result = classifyRolloutPlan(plan, phase);
  console.log(`[PASS] ${phase} plan contains ${result.approvedChanges} approved change(s)`);
}

const entryPath = process.argv[1];
if (entryPath && resolve(entryPath) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[FAIL] ${error instanceof Error ? error.message : "Unknown rollout plan error"}`);
    process.exitCode = 1;
  });
}
