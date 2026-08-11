// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import test from "node:test";

import { validateRolloutTransition } from "../rollout-transition-guard.mjs";

const phases = [
  "artifact-first",
  "identity-apply",
  "shared-key-off",
  "rollback-key-on",
  "rollback-connection-string",
];

const validTransitions = [
  ["absent", "artifact-first", false, true],
  ["artifact-first", "identity-apply", true, true],
  ["identity-apply", "shared-key-off", true, false],
  ["shared-key-off", "rollback-key-on", true, true],
  ["rollback-key-on", "rollback-connection-string", false, true],
];

function tfvars(useIdentityStorage, allowSharedKeyAccess) {
  return `
stamp_name = "staging"
use_identity_storage = ${useIdentityStorage}
allow_shared_key_access = ${allowSharedKeyAccess}
`;
}

test("all permitted rollout transitions pass with their exact Terraform gates", () => {
  for (const [parent, target, useIdentity, allowSharedKey] of validTransitions) {
    assert.doesNotThrow(() =>
      validateRolloutTransition(parent, target, tfvars(useIdentity, allowSharedKey)),
    );
  }
});

test("every transition outside the forward and rollback chains is rejected", () => {
  const allowed = new Set(validTransitions.map(([parent, target]) => `${parent}:${target}`));

  for (const parent of ["absent", ...phases]) {
    for (const target of phases) {
      if (allowed.has(`${parent}:${target}`)) continue;
      assert.throws(
        () => validateRolloutTransition(parent, target, tfvars(false, true)),
        /transition is not allowed/,
        `${parent} -> ${target} must be rejected`,
      );
    }
  }
});

test("every phase rejects each mismatched Terraform boolean gate", () => {
  for (const [parent, target, expectedIdentity, expectedSharedKey] of validTransitions) {
    for (const useIdentity of [false, true]) {
      for (const allowSharedKey of [false, true]) {
        if (useIdentity === expectedIdentity && allowSharedKey === expectedSharedKey) continue;
        assert.throws(
          () => validateRolloutTransition(
            parent,
            target,
            tfvars(useIdentity, allowSharedKey),
          ),
          /Terraform gate mismatch/,
          `${target} must reject ${useIdentity}/${allowSharedKey}`,
        );
      }
    }
  }
});

test("missing, duplicate, and non-literal Terraform gates are rejected", () => {
  const valid = tfvars(false, true);
  assert.throws(
    () => validateRolloutTransition("absent", "artifact-first", valid.replace(
      "use_identity_storage = false\n",
      "",
    )),
    /use_identity_storage must appear exactly once/,
  );
  assert.throws(
    () => validateRolloutTransition("absent", "artifact-first", `${valid}\nallow_shared_key_access = true\n`),
    /allow_shared_key_access must appear exactly once/,
  );
  assert.throws(
    () => validateRolloutTransition("absent", "artifact-first", valid.replace("false", "var.toggle")),
    /use_identity_storage must be a literal boolean/,
  );
});

test("unknown phase names are rejected", () => {
  assert.throws(
    () => validateRolloutTransition("absent", "production", tfvars(false, true)),
    /Unknown target phase/,
  );
  assert.throws(
    () => validateRolloutTransition("production", "artifact-first", tfvars(false, true)),
    /Unknown parent phase/,
  );
});
