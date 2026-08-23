#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
/**
 * spdx-header.mjs — enforce SPDX license headers (issue #145).
 *
 * This deliberately mirrors the SHAPE of `privacy-scan.mjs` (shebang, `[PASS]` /
 * `[FAIL]` reporters, a final total, `main().catch(err => process.exit(1))`,
 * exit 0 = clean / exit 1 = violations) so both success gates read the same. It
 * differs in TWO ways on purpose:
 *   1. It is STDLIB-ONLY (`node:*` imports, no npm packages) so it runs before
 *      `npm ci` — no `@azure/storage-blob` / `re2` dependencies.
 *   2. It is chained into `npm run lint` (a fast local + CI check), NOT wired up
 *      as its own standalone GitHub workflow.
 *
 * Two modes:
 *   node scripts/spdx-header.mjs          CHECK  — list files missing a header,
 *                                                  exit 1 if any, else exit 0.
 *   node scripts/spdx-header.mjs --fix    FIX    — idempotently stamp/upgrade
 *                                                  headers in place, exit 0.
 *
 * NOTE: the copyright YEAR is informational and NOT enforced — `hasHeader`
 * matches the holder + licence id only, never the year, so a file stamped in a
 * prior year is never flagged as stale.
 *
 * The pure functions (`isInScope`, `headerLines`, `hasHeader`, `applyFix`,
 * `isViolation`) plus the `walkDir` fallback enumerator are exported so the unit
 * suite can drive them directly with in-memory / temp-dir fixtures — no
 * child_process or git needed in tests.
 *
 * Enumeration is git-first: `git ls-files` (auto-respects .gitignore) is the
 * primary source; outside a git repo it falls back to `walkDir` (which skips the
 * same ignored dirs), so the checker degrades gracefully instead of crashing.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// ─── Config ─────────────────────────────────────────────────────────────────

export const HOLDER = "British Club Challenge authors";
export const LICENSE_ID = "MPL-2.0";
export const YEAR = new Date().getFullYear();

// ─── Comment styles ───────────────────────────────────────────────────────────

const LINE_SLASH = { kind: "line", prefix: "// " };
const LINE_HASH = { kind: "line", prefix: "# " };
const BLOCK_CSS = { kind: "block", open: "/* ", close: " */" };

// Positive allowlist of suffix → style. Sorted LONGEST-FIRST so a longer suffix
// always wins over a shorter one it contains — e.g. `.tfvars.example` before
// `.tfvars` before `.tf` (all `#`), and `.backend.hcl` / `.tftest.hcl` fall
// through to the `.hcl` rule. Anything not listed here is out of scope (null):
// JSON / .md / extensionless files are never stamped.
const SUFFIX_STYLES = [
  [".tfvars.example", LINE_HASH],
  [".tfvars", LINE_HASH],
  [".yaml", LINE_HASH],
  [".toml", LINE_HASH],
  [".tsx", LINE_SLASH],
  [".mts", LINE_SLASH],
  [".cts", LINE_SLASH],
  [".mjs", LINE_SLASH],
  [".cjs", LINE_SLASH],
  [".hcl", LINE_HASH],
  [".yml", LINE_HASH],
  [".css", BLOCK_CSS],
  [".ts", LINE_SLASH],
  [".js", LINE_SLASH],
  [".tf", LINE_HASH],
  [".sh", LINE_HASH],
].sort((a, b) => b[0].length - a[0].length);

// Exact basenames (no distinguishing extension) that take the `#` style.
const EXACT_BASENAMES = new Map([["Makefile", LINE_HASH]]);

// ─── SPDX detection ───────────────────────────────────────────────────────────

export const COPYRIGHT_RE = /SPDX-FileCopyrightText:.*British Club Challenge authors/;
export const LICENSE_RE = /SPDX-License-Identifier:\s*MPL-2\.0/;

const MAX_HEADER_LINES = 15;

// ─── Pure functions ───────────────────────────────────────────────────────────

/**
 * Classify a repo-relative path to a comment style, or null if out of scope.
 * @param {string} relPath
 * @returns {{kind:"line",prefix:string}|{kind:"block",open:string,close:string}|null}
 */
export function isInScope(relPath) {
  // 1. Hard exclusions (checked before the allowlist).
  if (/\.d\.(ts|mts|cts)$/.test(relPath)) return null;
  if (relPath === "apps/web/index.html") return null;
  if (relPath === ".github/FUNDING.yml") return null;
  // Terraform lock files are generated/tool-managed (`terraform init` rewrites
  // them) and match the `.hcl` rule below, so exclude them by basename before
  // the allowlist. Matches at any depth (iac/, iac/bootstrap/, modules/...).
  if (relPath.slice(relPath.lastIndexOf("/") + 1) === ".terraform.lock.hcl") return null;

  // 2. Positive allowlist — longest suffix wins.
  for (const [suffix, style] of SUFFIX_STYLES) {
    if (relPath.endsWith(suffix)) return style;
  }

  // 3. Exact basename allowlist.
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  return EXACT_BASENAMES.get(base) ?? null;
}

/**
 * The two header lines (copyright, then licence) for a given comment style.
 * @param {{kind:"line",prefix:string}|{kind:"block",open:string,close:string}} style
 * @returns {[string, string]}
 */
export function headerLines(style) {
  const copyright = `SPDX-FileCopyrightText: ${YEAR} ${HOLDER}`;
  const license = `SPDX-License-Identifier: ${LICENSE_ID}`;
  if (style.kind === "block") {
    return [
      `${style.open}${copyright}${style.close}`,
      `${style.open}${license}${style.close}`,
    ];
  }
  return [`${style.prefix}${copyright}`, `${style.prefix}${license}`];
}

/**
 * True iff, within the first 15 lines, some line matches the copyright pattern
 * AND some line matches the licence pattern.
 * @param {string} content
 * @returns {boolean}
 */
export function hasHeader(content) {
  // Strip a leading UTF-8 BOM first so it can't hide the header from the scan.
  const head = content.replace(/^\uFEFF/, "").split("\n").slice(0, MAX_HEADER_LINES);
  return head.some((l) => COPYRIGHT_RE.test(l)) && head.some((l) => LICENSE_RE.test(l));
}

/**
 * Idempotently return content with an SPDX header present.
 *  - already compliant → unchanged
 *  - licence-only (no copyright) within first 15 lines → insert copyright
 *    directly ABOVE the existing licence line (the 23-file upgrade case)
 *  - no SPDX at all → insert both lines after a shebang, else at the top
 * Empty content is skipped. A leading UTF-8 BOM is preserved at position 0 (the
 * header lands immediately after it). Trailing newline / other blank lines are
 * preserved.
 * @param {string} content
 * @param {{kind:"line",prefix:string}|{kind:"block",open:string,close:string}} style
 * @returns {string}
 */
export function applyFix(content, style) {
  if (content === "") return content;

  // Preserve a leading UTF-8 BOM: strip it, stamp the remainder, then re-prepend
  // it so the BOM stays at position 0 with the header immediately after.
  if (content.charCodeAt(0) === 0xfeff) {
    return `\uFEFF${applyFix(content.slice(1), style)}`;
  }

  if (hasHeader(content)) return content;

  const lines = content.split("\n");
  const [copyrightLine, licenseLine] = headerLines(style);
  const head = lines.slice(0, MAX_HEADER_LINES);
  const licenseIdx = head.findIndex((l) => LICENSE_RE.test(l));
  const copyrightIdx = head.findIndex((l) => COPYRIGHT_RE.test(l));

  // Upgrade case: a licence line exists but no copyright — insert copyright
  // immediately above it (same style, no blank line), leaving any following
  // JSDoc / imports untouched.
  if (licenseIdx !== -1 && copyrightIdx === -1) {
    lines.splice(licenseIdx, 0, copyrightLine);
    return lines.join("\n");
  }

  // No SPDX at all: keep a shebang on line 0, otherwise stamp at the very top.
  const insertAt = lines[0] !== undefined && lines[0].startsWith("#!") ? 1 : 0;
  lines.splice(insertAt, 0, copyrightLine, licenseLine);
  return lines.join("\n");
}

/**
 * CHECK-mode predicate: is this file content a header violation?
 * A zero-length (or BOM-only) file is NOT a violation — `applyFix` can never
 * stamp it, so flagging it would be an unfixable CI lock. Mirrors the empty
 * skip in `applyFix`.
 * @param {string} content
 * @returns {boolean}
 */
export function isViolation(content) {
  if (content.replace(/^\uFEFF/, "") === "") return false;
  return !hasHeader(content);
}

// ─── Reporters (privacy-scan shape) ───────────────────────────────────────────

function pass(check, detail) {
  console.log(`[PASS] ${check}${detail ? `: ${detail}` : ""}`);
}

function fail(check, detail) {
  console.error(`[FAIL] ${check}${detail ? `: ${detail}` : ""}`);
}

// ─── File enumeration ─────────────────────────────────────────────────────────

// Directory names skipped by the non-git `walkDir` fallback. When `git ls-files`
// is available (the primary path) .gitignore already excludes these; this set
// reproduces that outside a git repo (e.g. an exported source tarball).
const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  ".terraform",
  ".azurite",
  ".omo",
  ".worktrees",
  ".playwright-mcp",
  "playwright-report",
  "test-results",
  "logs",
  ".turbo",
]);

/**
 * Recursively yield repo-relative POSIX file paths under `dir`, skipping the
 * IGNORED_DIRS by directory name. The non-git fallback enumerator: the yielded
 * paths run through the SAME `isInScope` filter as the git path, so scope is
 * identical either way.
 * @param {string} dir
 * @returns {Generator<string>}
 */
export function* walkDir(dir = ".") {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = dir === "." ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      yield* walkDir(rel);
    } else if (entry.isFile()) {
      yield rel;
    }
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const doFix = process.argv.includes("--fix");
  const CHECK = "spdx-header";

  console.log("=== BCC SPDX Header Tool ===");
  console.log(`Mode: ${doFix ? "fix" : "check"}`);
  console.log("");

  // Primary: git ls-files (auto-respects .gitignore). Fallback: a directory
  // walk skipping the same ignored dirs, so the checker still runs outside a git
  // repo (e.g. a source tarball) instead of throwing.
  let files;
  try {
    files = execFileSync("git", ["ls-files"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    files = [...walkDir(".")];
  }

  const violations = [];
  let scanned = 0;
  let changed = 0;

  for (const rel of files) {
    const style = isInScope(rel);
    if (!style) continue;
    scanned++;

    let content;
    try {
      content = readFileSync(rel, "utf8");
    } catch (err) {
      console.warn(`[WARN] ${CHECK}: could not read ${rel}: ${err.message}`);
      continue;
    }

    if (doFix) {
      const fixed = applyFix(content, style);
      if (fixed !== content) {
        writeFileSync(rel, fixed);
        changed++;
      }
    } else if (isViolation(content)) {
      violations.push(rel);
    }
  }

  console.log("");

  if (doFix) {
    pass(`${CHECK}-fix`, `${changed} file(s) stamped (of ${scanned} in scope)`);
    console.log("");
    console.log(`Result: FIXED — ${changed} file(s) changed of ${scanned} in scope.`);
    process.exit(0);
  }

  if (violations.length === 0) {
    pass(CHECK, `${scanned} in-scope file(s) scanned, all carry a header`);
    console.log("");
    console.log(`Result: PASS — 0 missing of ${scanned} in-scope file(s).`);
    process.exit(0);
  }

  for (const v of violations) fail(CHECK, `missing header: ${v}`);
  console.log("");
  console.error(
    `Result: FAIL — ${violations.length} file(s) missing an SPDX header (of ${scanned} in scope).`,
  );
  process.exit(1);
}

// Only run the CLI when executed as the entry script — importing this module
// (e.g. from the unit suite) must have no side effects.
const runningAsScript =
  import.meta.main ??
  (process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false);

if (runningAsScript) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
