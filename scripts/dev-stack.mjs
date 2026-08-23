#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * Native local dev stack orchestrator for `make dev`.
 *
 * Starts Azurite (npx, from the pinned devDependency), waits for it to
 * become reachable, then runs `make dev-api` and `make dev-web` concurrently
 * (each already builds/seeds/inits what it needs). Ctrl-C stops everything.
 */

import { spawn } from "node:child_process";

const AZURITE_STATUS_URL = "http://127.0.0.1:10000/devstoreaccount1?comp=list";

const children = [];

function spawnManaged(command, args) {
  // detached: true makes the child its own process-group leader, so signaling
  // -child.pid (the group) reaches grandchildren too — needed because `make
  // dev-api` chains through npm to `func start`, and a plain SIGTERM to just
  // the immediate child doesn't reliably cascade through that.
  const child = spawn(command, args, { stdio: "inherit", detached: true });
  children.push(child);
  return child;
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.killed) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve())),
    delay(5_000).then(() => {
      if (child.exitCode === null && !child.killed) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }),
  ]);
}

async function stopAll() {
  await Promise.all(children.map(stopProcess));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAzurite(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(AZURITE_STATUS_URL);
      if ([200, 400, 403].includes(response.status)) return;
    } catch {
      // not up yet
    }
    await delay(500);
  }
  throw new Error("Azurite did not become ready within 30s");
}

async function main() {
  console.log("[dev-stack] starting Azurite...");
  spawnManaged("npx", ["azurite", "--location", ".azurite", "--skipApiVersionCheck", "--silent"]);
  await waitForAzurite();

  console.log("[dev-stack] starting API and Web...");
  spawnManaged("make", ["dev-api"]);
  spawnManaged("make", ["dev-web"]);
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n[dev-stack] shutting down...");
  await stopAll();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch(async (err) => {
  console.error("[dev-stack]", err.message);
  await stopAll();
  process.exit(1);
});
