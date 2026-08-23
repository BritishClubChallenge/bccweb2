// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/// <reference types="@testing-library/jest-dom" />
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach } from "vitest";
import { cleanup } from "@testing-library/react";

/**
 * React-19 console regression gate.
 *
 * React 19 routes most actionable warnings (key warnings, "Cannot update a
 * component while rendering a different component", removed-API / deprecation
 * warnings, act() warnings, invalid-prop warnings) through `console.error`
 * (and a few through `console.warn`). This gate turns ANY un-allowlisted
 * `console.error` / `console.warn` emitted during a test into a test FAILURE,
 * so a React-19 regression surfaces across every web suite instead of
 * scrolling past silently in stderr.
 *
 * Implementation note: the gate swaps `console.error`/`console.warn` by direct
 * assignment rather than `vi.spyOn`. Several suites call `vi.resetAllMocks()` /
 * `vi.restoreAllMocks()` in their own hooks; a `vi.spyOn` gate would be reset
 * mid-test by those calls and silently stop gating. Direct assignment is immune
 * to the vitest mock lifecycle, so the gate stays active for every test.
 *
 * Coexistence with per-test console spies: this `beforeEach` installs the gate
 * first; any test that installs its OWN `vi.spyOn(console, ...)` afterwards
 * (ErrorBoundary.test.tsx, router-guards.test.tsx) wraps the gate with a noop,
 * so its intentional console output never reaches the gate.
 *
 * Allowlist below = messages known-benign on the React-18 baseline (Task 1,
 * qa-evidence/baseline/test.txt). Each entry MUST have a rationale. Do NOT
 * widen this list to silence a genuine React-19 warning — root-cause it in the
 * source instead.
 */
const CONSOLE_ALLOWLIST: RegExp[] = [
  // ErrorBoundary.test.tsx deliberately throws `Error: Boom!`; React logs caught
  // render errors via console.error with a "The above error occurred in ..."
  // component-stack message. That test also mocks console.error itself, so this
  // entry is defensive in case its spy ordering ever changes.
  /The above error occurred in/,
  // jsdom logs "Not implemented:" to console.error when code touches a browser
  // API it does not implement. The React-18 baseline showed NONE of these in the
  // web suite; they are allowlisted defensively so a future test exercising a
  // dialog / native form submit / scroll / navigation does not trip the gate
  // with a non-React, environment-only message.
  /Not implemented: HTMLDialogElement\.prototype\.showModal/,
  /Not implemented: HTMLFormElement\.prototype\.requestSubmit/,
  /Not implemented: navigation/,
  /Not implemented: window\.scrollTo/,
];

let unexpectedConsole: string[] = [];
let restoreConsole: (() => void) | undefined;

function stringifyArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// Browser-safe printf formatter mirroring console's %s/%d/%o substitution so
// React warnings render readably in the gate's failure output. Deliberately
// uses NO `node:*` builtins (e.g. util.format): this file is under apps/web's
// tsconfig `include: ["src"]`, which has no `@types/node`, so a Node import
// here fails `tsc --noEmit` in CI.
function formatArgs(args: unknown[]): string {
  if (args.length === 0) return "";
  const first = args[0];
  if (typeof first !== "string") return args.map(stringifyArg).join(" ");

  let next = 1;
  const formatted = first.replace(/%[sdifoOjc%]/g, (spec) => {
    if (spec === "%%") return "%";
    if (next >= args.length) return spec;
    const arg = args[next++];
    switch (spec) {
      case "%c":
        return ""; // CSS directive: consume the arg, emit nothing
      case "%d":
      case "%i":
        if (typeof arg === "bigint") return String(arg);
        return Number.isNaN(Number(arg)) ? "NaN" : String(Math.trunc(Number(arg)));
      case "%f":
        return Number.isNaN(Number(arg)) ? "NaN" : String(Number(arg));
      case "%j":
        try {
          return JSON.stringify(arg);
        } catch {
          return "[Circular]";
        }
      case "%o":
      case "%O":
        return stringifyArg(arg);
      default:
        return typeof arg === "string" ? arg : stringifyArg(arg);
    }
  });

  const rest = args.slice(next).map(stringifyArg);
  return rest.length > 0 ? `${formatted} ${rest.join(" ")}` : formatted;
}

beforeEach(() => {
  unexpectedConsole = [];
  const original = { error: console.error.bind(console), warn: console.warn.bind(console) };

  const gate = (method: "error" | "warn") => (...args: unknown[]) => {
    const message = formatArgs(args);
    if (CONSOLE_ALLOWLIST.some((re) => re.test(message))) {
      original[method](...args);
      return;
    }
    unexpectedConsole.push(`console.${method}: ${message}`);
  };

  console.error = gate("error");
  console.warn = gate("warn");
  restoreConsole = () => {
    console.error = original.error;
    console.warn = original.warn;
  };
});

afterEach(() => {
  restoreConsole?.();
  restoreConsole = undefined;
  cleanup();
  if (unexpectedConsole.length > 0) {
    const captured = unexpectedConsole.join("\n");
    unexpectedConsole = [];
    throw new Error(
      "Unexpected console.error/console.warn during test (React-19 regression gate). " +
        "If this is a genuine React-19 warning, root-cause it in the source; do NOT " +
        "widen the allowlist in src/__tests__/setup.ts to mask it.\n" +
        captured,
    );
  }
});
