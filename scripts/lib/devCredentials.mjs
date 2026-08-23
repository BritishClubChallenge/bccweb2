// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

const CREDENTIAL_MODE = 0o600;
const CREDENTIAL_KEYS = new Set(["ADMIN_EMAIL", "ADMIN_PASSWORD"]);
export const DEV_CREDENTIALS_PATH = ".dev-credentials";

export class DevCredentialError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "DevCredentialError";
  }
}

export function devCredentialsPath(cwd = process.cwd()) {
  return resolve(cwd, DEV_CREDENTIALS_PATH);
}

function parseCredentials(contents, path) {
  const values = new Map();
  for (const line of contents.split("\n")) {
    if (line === "") continue;
    const separator = line.indexOf("=");
    const key = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1);
    if (!CREDENTIAL_KEYS.has(key) || values.has(key) || value.length === 0) {
      throw new DevCredentialError(`malformed admin credential file at ${path}`);
    }
    values.set(key, value);
  }
  if (values.size !== CREDENTIAL_KEYS.size) {
    throw new DevCredentialError(`malformed admin credential file at ${path}`);
  }
  return {
    email: values.get("ADMIN_EMAIL"),
    password: values.get("ADMIN_PASSWORD"),
  };
}

export function assertSafeCredentialOwner(stat, path, options = {}) {
  const currentUid = options.currentUid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  if (currentUid === undefined || stat.uid === currentUid) return;
  throw new DevCredentialError(`admin credential file must be owned by the current user: ${path}`);
}

function assertSafeDescriptor(stat, path) {
  if (!stat.isFile()) {
    throw new DevCredentialError(`admin credential path must be a regular file: ${path}`);
  }
  if (stat.nlink !== 1) {
    throw new DevCredentialError(`admin credential file must have a single link: ${path}`);
  }
  if ((stat.mode & 0o777) !== CREDENTIAL_MODE) {
    throw new DevCredentialError(`admin credential file must have mode 0600: ${path}`);
  }
  assertSafeCredentialOwner(stat, path);
}

function openCredential(path) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      throw new DevCredentialError(`missing admin credential file at ${path}`, { cause });
    }
    throw new DevCredentialError(`admin credential path must be a regular file: ${path}`, { cause });
  }
  assertSafeDescriptor(fstatSync(descriptor), path);
  return descriptor;
}

export function readDevCredentials(path = devCredentialsPath()) {
  const descriptor = openCredential(path);
  try {
    return parseCredentials(readFileSync(descriptor, "utf8"), path);
  } finally {
    closeSync(descriptor);
  }
}

export function readInitializedDevCredentials(path = devCredentialsPath()) {
  let descriptor;
  try {
    descriptor = openCredential(path);
  } catch (error) {
    if (error instanceof DevCredentialError && error.cause?.code === "ENOENT") return null;
    throw error;
  }
  try {
    if (fstatSync(descriptor).size === 0) return null;
    return parseCredentials(readFileSync(descriptor, "utf8"), path);
  } finally {
    closeSync(descriptor);
  }
}

export function resolveAdminPassword(override, path = devCredentialsPath()) {
  if (typeof override === "string" && override.length > 0) return override;
  const credentials = readDevCredentials(path);
  if (credentials.email !== "admin@bcc.local") {
    throw new DevCredentialError(`admin credential email is invalid in ${path}`);
  }
  return credentials.password;
}

export function writeDevCredentials(credentials, path = devCredentialsPath()) {
  let descriptor;
  try {
    try {
      descriptor = openSync(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        CREDENTIAL_MODE,
      );
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause;
      descriptor = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
      const stat = fstatSync(descriptor);
      assertSafeDescriptor(stat, path);
      if (stat.size !== 0) {
        throw new DevCredentialError(`refusing to replace existing admin credential file at ${path}`);
      }
    }
    writeFileSync(
      descriptor,
      `ADMIN_EMAIL=${credentials.email}\nADMIN_PASSWORD=${credentials.password}\n`,
      "utf8",
    );
    fsyncSync(descriptor);
  } catch (cause) {
    if (cause instanceof DevCredentialError) throw cause;
    throw new DevCredentialError(`could not create private admin credential file at ${path}`, { cause });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function prepareDevCredentialsFile(path = devCredentialsPath()) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      CREDENTIAL_MODE,
    );
    fsyncSync(descriptor);
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) {
      throw new DevCredentialError(`could not create private admin credential file at ${path}`, { cause });
    }
    descriptor = openCredential(path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
