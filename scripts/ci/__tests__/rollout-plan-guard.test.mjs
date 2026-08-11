// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import test from "node:test";

import { classifyRolloutPlan } from "../rollout-plan-guard.mjs";

function change(address, actions, before, after, type = "azapi_resource") {
  return { address, mode: "managed", type, name: address.split(".").at(-1), change: { actions, before, after } };
}

function plan(...resourceChanges) {
  return { format_version: "1.2", resource_changes: resourceChanges };
}

const stagingRuntime = {
  name: "stbccwebstagingrt",
  body: { properties: { allowSharedKeyAccess: true, minimumTlsVersion: "TLS1_2" } },
};

const functionIdentity = change(
  "module.stamp.azapi_resource.fn_umi",
  ["no-op"],
  {
    id: "/subscriptions/test/resourceGroups/stamp-staging/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-bccweb-staging-fn",
    name: "id-bccweb-staging-fn",
    output: { properties: {
      clientId: "cbbdfdb9-5743-46b9-8ad1-03b94303c0ef",
      principalId: "11111111-1111-4111-8111-111111111111",
    } },
  },
  {
    id: "/subscriptions/test/resourceGroups/stamp-staging/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-bccweb-staging-fn",
    name: "id-bccweb-staging-fn",
    output: { properties: {
      clientId: "cbbdfdb9-5743-46b9-8ad1-03b94303c0ef",
      principalId: "11111111-1111-4111-8111-111111111111",
    } },
  },
);

const stagingFunctionBefore = {
  name: "func-bccweb-staging",
  body: {
    properties: {
      siteConfig: { appSettings: [
        { name: "AzureWebJobsStorage", value: "sensitive-runtime" },
        { name: "BLOB_CONNECTION_STRING", value: "sensitive-data" },
        { name: "JWT_SECRET", value: "@Microsoft.KeyVault(staging-jwt)" },
      ] },
      functionAppConfig: {
        deployment: { storage: { authentication: { type: "StorageAccountConnectionString" } } },
      },
    },
  },
};

const stagingFunctionAfter = {
  name: "func-bccweb-staging",
  body: {
    properties: {
      siteConfig: {
        appSettings: [
          { name: "AzureWebJobsStorage__accountName", value: "stbccwebstagingrt" },
          { name: "AzureWebJobsStorage__credential", value: "managedidentity" },
          { name: "AzureWebJobsStorage__clientId", value: "cbbdfdb9-5743-46b9-8ad1-03b94303c0ef" },
          { name: "BLOB_STORAGE_ACCOUNT_NAME", value: "stbccwebstagingdata" },
          { name: "STORAGE_UMI_CLIENT_ID", value: "cbbdfdb9-5743-46b9-8ad1-03b94303c0ef" },
          { name: "JWT_SECRET", value: "@Microsoft.KeyVault(staging-jwt)" },
        ],
      },
      functionAppConfig: {
        deployment: {
          storage: {
            authentication: {
              type: "UserAssignedIdentity",
              userAssignedIdentityResourceId: "/subscriptions/test/resourceGroups/stamp-staging/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-bccweb-staging-fn",
            },
          },
        },
      },
    },
  },
};

test("identity phase allows staging role, function settings, policy, and key forget changes", () => {
  const fixture = plan(
    functionIdentity,
    change(
      "module.stamp.azapi_resource.storage_runtime",
      ["update"],
      { ...stagingRuntime, body: { properties: { ...stagingRuntime.body.properties, allowSharedKeyAccess: false } } },
      stagingRuntime,
    ),
    change(
      "module.stamp.azapi_resource.function_app",
      ["update"],
      stagingFunctionBefore,
      stagingFunctionAfter,
    ),
    change(
      "module.stamp.random_uuid.fn_runtime_blob_owner[0]",
      ["create"],
      null,
      { result: "00000000-0000-4000-8000-000000000001" },
      "random_uuid",
    ),
    change(
      "module.stamp.azapi_resource.fn_runtime_blob_owner_role[0]",
      ["create"],
      null,
      {
        type: "Microsoft.Authorization/roleAssignments@2022-04-01",
        parent_id: "/subscriptions/test/resourceGroups/stamp-staging/providers/Microsoft.Storage/storageAccounts/stbccwebstagingrt",
        body: { properties: {
          roleDefinitionId: "/subscriptions/test/providers/Microsoft.Authorization/roleDefinitions/b7e6dc6d-f1e8-4753-8033-0f276bb0955b",
          principalId: "11111111-1111-4111-8111-111111111111",
          principalType: "ServicePrincipal",
        } },
      },
    ),
    change(
      "module.stamp.azapi_resource_action.storage_runtime_keys",
      ["forget"],
      { resource_id: "/subscriptions/test/resourceGroups/stamp-staging/providers/Microsoft.Storage/storageAccounts/stbccwebstagingrt" },
      null,
      "azapi_resource_action",
    ),
    change(
      "module.stamp.azapi_resource_action.storage_data_keys",
      ["forget"],
      { resource_id: "/subscriptions/test/resourceGroups/stamp-staging/providers/Microsoft.Storage/storageAccounts/stbccwebstagingdata" },
      null,
      "azapi_resource_action",
    ),
  );

  assert.deepEqual(classifyRolloutPlan(fixture, "identity-apply"), {
    approvedChanges: 6,
    phase: "identity-apply",
  });
});

test("rollback connection-string phase allows only the two legacy key-action creates", () => {
  const fixture = plan(
    change(
      "module.stamp.azapi_resource_action.storage_runtime_keys_legacy[0]",
      ["create"],
      null,
      {
        action: "listKeys",
        resource_id: "/subscriptions/test/resourceGroups/stamp-staging/providers/Microsoft.Storage/storageAccounts/stbccwebstagingrt",
      },
      "azapi_resource_action",
    ),
    change(
      "module.stamp.azapi_resource_action.storage_data_keys_legacy[0]",
      ["create"],
      null,
      {
        action: "listKeys",
        resource_id: "/subscriptions/test/resourceGroups/stamp-staging/providers/Microsoft.Storage/storageAccounts/stbccwebstagingdata",
      },
      "azapi_resource_action",
    ),
  );

  assert.equal(classifyRolloutPlan(fixture, "rollback-connection-string").approvedChanges, 2);
});

test("resource deletes and replacements are always rejected", () => {
  for (const actions of [["delete"], ["delete", "create"], ["create", "delete"]]) {
    assert.throws(
      () => classifyRolloutPlan(plan(change(
        "module.stamp.azapi_resource.storage_runtime",
        actions,
        stagingRuntime,
        null,
      )), "shared-key-off"),
      /delete or replace/,
    );
  }
});

test("addresses outside the exact staging stamp surfaces are rejected", () => {
  assert.throws(
    () => classifyRolloutPlan(plan(change(
      "module.prod.azapi_resource.storage_runtime",
      ["update"],
      stagingRuntime,
      { ...stagingRuntime, body: { properties: { ...stagingRuntime.body.properties, allowSharedKeyAccess: false } } },
    )), "shared-key-off"),
    /address is not permitted/,
  );
});

test("deferred reads are rejected instead of bypassing staging scope checks", () => {
  assert.throws(
    () => classifyRolloutPlan(plan(change(
      "data.azapi_resource.production",
      ["read"],
      null,
      { name: "stbccwebprodrt" },
      "azapi_resource",
    )), "identity-apply"),
    /deferred read outside the rollout surfaces/,
  );
});

test("non-staging resource names are rejected even at an allowed address", () => {
  assert.throws(
    () => classifyRolloutPlan(plan(change(
      "module.stamp.azapi_resource.storage_runtime",
      ["update"],
      { ...stagingRuntime, name: "stbccwebprodrt" },
      { ...stagingRuntime, name: "stbccwebprodrt", body: { properties: { ...stagingRuntime.body.properties, allowSharedKeyAccess: false } } },
    )), "shared-key-off"),
    /non-staging resource name/,
  );
});

test("storage and function updates reject unrelated property changes", () => {
  assert.throws(
    () => classifyRolloutPlan(plan(change(
      "module.stamp.azapi_resource.storage_runtime",
      ["update"],
      stagingRuntime,
      { ...stagingRuntime, body: { properties: { ...stagingRuntime.body.properties, minimumTlsVersion: "TLS1_0" } } },
    )), "identity-apply"),
    /outside allowSharedKeyAccess/,
  );
  assert.throws(
    () => classifyRolloutPlan(plan(change(
      "module.stamp.azapi_resource.function_app",
      ["update"],
      stagingFunctionBefore,
      { ...stagingFunctionAfter, body: { properties: { ...stagingFunctionAfter.body.properties, httpsOnly: false } } },
    )), "identity-apply"),
    /outside app settings and deployment authentication/,
  );
});

test("allowed properties reject target values that disagree with the phase", () => {
  assert.throws(
    () => classifyRolloutPlan(plan(change(
      "module.stamp.azapi_resource.storage_runtime",
      ["update"],
      stagingRuntime,
      { ...stagingRuntime, body: { properties: { ...stagingRuntime.body.properties, allowSharedKeyAccess: false } } },
    )), "identity-apply"),
    /allowSharedKeyAccess must be true/,
  );
  assert.throws(
    () => classifyRolloutPlan(plan(change(
      "module.stamp.azapi_resource.function_app",
      ["update"],
      stagingFunctionBefore,
      stagingFunctionAfter,
    )), "rollback-connection-string"),
    /deployment authentication must be StorageAccountConnectionString/,
  );
});

test("role creates reject privilege, principal, and scope changes at approved addresses", () => {
  const baseRole = {
    type: "Microsoft.Authorization/roleAssignments@2022-04-01",
    parent_id: "/subscriptions/test/resourceGroups/stamp-staging/providers/Microsoft.Storage/storageAccounts/stbccwebstagingrt",
    body: { properties: {
      roleDefinitionId: "/subscriptions/test/providers/Microsoft.Authorization/roleDefinitions/b7e6dc6d-f1e8-4753-8033-0f276bb0955b",
      principalId: "11111111-1111-4111-8111-111111111111",
      principalType: "ServicePrincipal",
    } },
  };
  const attacks = [
    { ...baseRole, body: { properties: { ...baseRole.body.properties, roleDefinitionId: "/subscriptions/test/providers/Microsoft.Authorization/roleDefinitions/owner" } } },
    { ...baseRole, body: { properties: { ...baseRole.body.properties, principalId: "4eabcaaf-5340-41b7-9ed2-7b47ebeaa7cd" } } },
    { ...baseRole, parent_id: "/subscriptions/test/resourceGroups/stamp-staging" },
  ];
  for (const after of attacks) {
    assert.throws(
      () => classifyRolloutPlan(plan(functionIdentity, change(
        "module.stamp.azapi_resource.fn_runtime_blob_owner_role[0]",
        ["create"],
        null,
        after,
      )), "identity-apply"),
      /role assignment does not match/,
    );
  }
});

test("function updates reject unrelated app-setting and authentication-field changes", () => {
  const alteredSecret = structuredClone(stagingFunctionAfter);
  alteredSecret.body.properties.siteConfig.appSettings.find(
    ({ name }) => name === "JWT_SECRET",
  ).value = "attacker-controlled";
  assert.throws(
    () => classifyRolloutPlan(plan(functionIdentity, change(
      "module.stamp.azapi_resource.function_app",
      ["update"],
      stagingFunctionBefore,
      alteredSecret,
    )), "identity-apply"),
    /unrelated app setting/,
  );

  const alteredIdentity = structuredClone(stagingFunctionAfter);
  alteredIdentity.body.properties.functionAppConfig.deployment.storage.authentication
    .userAssignedIdentityResourceId =
      "/subscriptions/test/resourceGroups/stamp-staging/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-bccweb-staging-other";
  assert.throws(
    () => classifyRolloutPlan(plan(functionIdentity, change(
      "module.stamp.azapi_resource.function_app",
      ["update"],
      stagingFunctionBefore,
      alteredIdentity,
    )), "identity-apply"),
    /deployment authentication does not match/,
  );
});

test("rollback rejects connection strings for any account except the staging pair", () => {
  const rollbackAfter = structuredClone(stagingFunctionBefore);
  rollbackAfter.body.properties.functionAppConfig.deployment.storage.authentication = {
    type: "StorageAccountConnectionString",
    storageAccountConnectionStringName: "AzureWebJobsStorage",
  };
  rollbackAfter.body.properties.siteConfig.appSettings.find(
    ({ name }) => name === "AzureWebJobsStorage",
  ).value = "DefaultEndpointsProtocol=https;AccountName=attacker;AccountKey=secret;EndpointSuffix=core.windows.net";
  assert.throws(
    () => classifyRolloutPlan(plan(change(
      "module.stamp.azapi_resource.function_app",
      ["update"],
      stagingFunctionAfter,
      rollbackAfter,
    )), "rollback-connection-string"),
    /connection string does not target stbccwebstagingrt/,
  );
});

test("nested references to non-staging resources are rejected", () => {
  const prodFunction = structuredClone(stagingFunctionAfter);
  prodFunction.body.properties.functionAppConfig.deployment.storage.authentication
    .userAssignedIdentityResourceId =
      "/subscriptions/test/resourceGroups/stamp-prod/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-bccweb-prod-fn";
  assert.throws(
    () => classifyRolloutPlan(plan(functionIdentity, change(
      "module.stamp.azapi_resource.function_app",
      ["update"],
      stagingFunctionBefore,
      prodFunction,
    )), "identity-apply"),
    /non-staging resource name/,
  );
});

test("key-action forgets and creates are rejected in the wrong phase", () => {
  assert.throws(
    () => classifyRolloutPlan(plan(change(
      "module.stamp.azapi_resource_action.storage_runtime_keys",
      ["forget"],
      { resource_id: "/subscriptions/test/resourceGroups/stamp-staging/providers/Microsoft.Storage/storageAccounts/stbccwebstagingrt" },
      null,
      "azapi_resource_action",
    )), "shared-key-off"),
    /only permitted during identity-apply/,
  );
  assert.throws(
    () => classifyRolloutPlan(plan(change(
      "module.stamp.azapi_resource_action.storage_runtime_keys_legacy[0]",
      ["create"],
      null,
      {
        action: "listKeys",
        resource_id: "/subscriptions/test/resourceGroups/stamp-staging/providers/Microsoft.Storage/storageAccounts/stbccwebstagingrt",
      },
      "azapi_resource_action",
    )), "rollback-key-on"),
    /only permitted during rollback-connection-string/,
  );
});
