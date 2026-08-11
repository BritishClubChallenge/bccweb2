// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import { isDeepStrictEqual } from "node:util";

export const roleNames = [
  "fn_runtime_blob_owner", "fn_runtime_queue_contributor",
  "fn_runtime_table_contributor", "fn_data_blob_contributor",
  "operator_runtime_queue_contributor", "operator_deployment_blob_contributor",
  "operator_data_blob_contributor",
];

const operatorPrincipalId = "4eabcaaf-5340-41b7-9ed2-7b47ebeaa7cd";
const functionClientId = "cbbdfdb9-5743-46b9-8ad1-03b94303c0ef";
const roleContracts = new Map([
  ["fn_runtime_blob_owner", ["b7e6dc6d-f1e8-4753-8033-0f276bb0955b", "stbccwebstagingrt", "function"]],
  ["fn_runtime_queue_contributor", ["974c5e8b-45b9-4653-ba55-5f855dd0fb88", "stbccwebstagingrt", "function"]],
  ["fn_runtime_table_contributor", ["0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3", "stbccwebstagingrt", "function"]],
  ["fn_data_blob_contributor", ["ba92f5b4-2d11-453d-a403-e96b0029c9fe", "stbccwebstagingdata", "function"]],
  ["operator_runtime_queue_contributor", ["974c5e8b-45b9-4653-ba55-5f855dd0fb88", "stbccwebstagingrt", "operator"]],
  ["operator_deployment_blob_contributor", ["ba92f5b4-2d11-453d-a403-e96b0029c9fe", "stbccwebstagingrt/blobServices/default/containers/deploymentpackage", "operator"]],
  ["operator_data_blob_contributor", ["ba92f5b4-2d11-453d-a403-e96b0029c9fe", "stbccwebstagingdata", "operator"]],
]);

function settingsMap(settings, address) {
  if (!Array.isArray(settings)) throw new Error(`${address} app settings must be an array`);
  const result = new Map();
  for (const setting of settings) {
    if (typeof setting?.name !== "string" || result.has(setting.name)) {
      throw new Error(`${address} app settings contain an invalid or duplicate name`);
    }
    result.set(setting.name, setting.value);
  }
  return result;
}

function assertConnectionAccount(value, expectedAccount, address) {
  if (typeof value !== "string") {
    throw new Error(`${address} connection string is not a string`);
  }
  const account = value.split(";").find((part) => part.startsWith("AccountName="))
    ?.slice("AccountName=".length);
  if (account !== expectedAccount) {
    throw new Error(`${address} connection string does not target ${expectedAccount}`);
  }
}

function assertFunctionSettings(resourceChange, phase, identity) {
  const before = settingsMap(resourceChange.change.before?.body?.properties?.siteConfig?.appSettings, resourceChange.address);
  const after = settingsMap(resourceChange.change.after?.body?.properties?.siteConfig?.appSettings, resourceChange.address);
  const identityNames = new Set([
    "AzureWebJobsStorage__accountName", "AzureWebJobsStorage__credential",
    "AzureWebJobsStorage__clientId", "BLOB_STORAGE_ACCOUNT_NAME", "STORAGE_UMI_CLIENT_ID",
  ]);
  const connectionNames = new Set(["AzureWebJobsStorage", "BLOB_CONNECTION_STRING"]);
  const rolloutNames = new Set([...identityNames, ...connectionNames]);
  for (const [name, value] of before) {
    if (!rolloutNames.has(name) && !isDeepStrictEqual(after.get(name), value)) {
      throw new Error(`${resourceChange.address} changes unrelated app setting ${name}`);
    }
  }
  for (const name of after.keys()) {
    if (!rolloutNames.has(name) && !before.has(name)) {
      throw new Error(`${resourceChange.address} adds unrelated app setting ${name}`);
    }
  }
  if (phase === "rollback-connection-string") {
    if ([...identityNames].some((name) => after.has(name))) throw new Error(`${resourceChange.address} retains identity app settings during rollback`);
    if ([...connectionNames].some((name) => !after.has(name))) throw new Error(`${resourceChange.address} is missing connection-string app settings`);
    assertConnectionAccount(after.get("AzureWebJobsStorage"), "stbccwebstagingrt", resourceChange.address);
    assertConnectionAccount(after.get("BLOB_CONNECTION_STRING"), "stbccwebstagingdata", resourceChange.address);
    return;
  }
  const expected = new Map([
    ["AzureWebJobsStorage__accountName", "stbccwebstagingrt"],
    ["AzureWebJobsStorage__credential", "managedidentity"],
    ["AzureWebJobsStorage__clientId", identity.clientId ?? functionClientId],
    ["BLOB_STORAGE_ACCOUNT_NAME", "stbccwebstagingdata"],
    ["STORAGE_UMI_CLIENT_ID", identity.clientId ?? functionClientId],
  ]);
  if ([...connectionNames].some((name) => after.has(name))) throw new Error(`${resourceChange.address} retains connection-string app settings in identity mode`);
  for (const [name, value] of expected) {
    if (!isDeepStrictEqual(after.get(name), value)) throw new Error(`${resourceChange.address} identity app setting ${name} does not match`);
  }
}

export function assertFunctionContract(resourceChange, phase, identity, assertOnlyPathsChanged) {
  assertOnlyPathsChanged(resourceChange, [
    ["body", "properties", "siteConfig", "appSettings"],
    ["body", "properties", "functionAppConfig", "deployment", "storage", "authentication"],
  ], "app settings and deployment authentication");
  const expectedType = phase === "rollback-connection-string" ? "StorageAccountConnectionString" : "UserAssignedIdentity";
  const authentication = resourceChange.change.after?.body?.properties?.functionAppConfig?.deployment?.storage?.authentication;
  if (authentication?.type !== expectedType) throw new Error(`${resourceChange.address} deployment authentication must be ${expectedType} during ${phase}`);
  assertFunctionSettings(resourceChange, phase, identity);
  const expected = phase === "rollback-connection-string"
    ? { type: expectedType, storageAccountConnectionStringName: "AzureWebJobsStorage" }
    : { type: expectedType, userAssignedIdentityResourceId: identity.id };
  if (!isDeepStrictEqual(authentication, expected)) throw new Error(`${resourceChange.address} deployment authentication does not match ${phase}`);
}

export function assertRoleContract(resourceChange, identity) {
  if (!isDeepStrictEqual(resourceChange.change.actions, ["create"])) throw new Error(`${resourceChange.address} role surface only permits create`);
  if (resourceChange.type === "random_uuid") return;
  const after = resourceChange.change.after;
  const name = roleNames.find((candidate) => resourceChange.address.includes(`.${candidate}`));
  const contract = name ? roleContracts.get(name) : undefined;
  const properties = after?.body?.properties;
  const principalId = contract?.[2] === "function" ? identity.principalId : operatorPrincipalId;
  if (after?.type !== "Microsoft.Authorization/roleAssignments@2022-04-01" || !contract ||
    typeof after.parent_id !== "string" || !after.parent_id.endsWith(`/storageAccounts/${contract[1]}`) ||
    typeof properties?.roleDefinitionId !== "string" || !properties.roleDefinitionId.endsWith(`/roleDefinitions/${contract[0]}`) ||
    properties.principalId !== principalId || properties.principalType !== "ServicePrincipal") {
    throw new Error(`${resourceChange.address} role assignment does not match its rollout contract`);
  }
}
