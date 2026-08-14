#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0

import { fileURLToPath } from "node:url";

const DEVELOPMENT_STORAGE_ACCOUNT = "devstoreaccount1";
const STORAGE_ACCOUNT_PATTERN = /^[a-z0-9]{3,24}$/;
const STORAGE_KEYS = new Set([
  "accountname",
  "blobendpoint",
  "defaultendpointsprotocol",
  "endpointsuffix",
  "usedevelopmentstorage",
]);
const SQL_KEYS = new Set([
  "addr",
  "address",
  "database",
  "data source",
  "initial catalog",
  "network address",
  "server",
]);

function unquote(value) {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value.at(-1);
  if ((first === '"' || first === "'") && last === first) {
    return value.slice(1, -1).replaceAll(first + first, first);
  }
  if (first === "{" && last === "}") {
    return value.slice(1, -1).replaceAll("}}", "}");
  }
  return value;
}

function selectedConnectionFields(connectionString, selectedKeys) {
  const fields = new Map();
  let start = 0;
  let quote = null;
  let braced = false;

  function collect(end) {
    const part = connectionString.slice(start, end).trim();
    const separator = part.indexOf("=");
    if (separator <= 0) return;
    const key = part.slice(0, separator).trim().toLowerCase();
    if (!selectedKeys.has(key)) return;
    fields.set(key, unquote(part.slice(separator + 1).trim()));
  }

  for (let index = 0; index <= connectionString.length; index += 1) {
    const character = connectionString[index];
    if (index === connectionString.length) {
      collect(index);
      break;
    }
    if (quote) {
      if (character === quote) {
        if (connectionString[index + 1] === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (braced) {
      if (character === "}") {
        if (connectionString[index + 1] === "}") index += 1;
        else braced = false;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "{") {
      braced = true;
    } else if (character === ";") {
      collect(index);
      start = index + 1;
    }
  }
  return fields;
}

function sanitizedEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("BlobEndpoint must be a valid URL");
  }
  endpoint.username = "";
  endpoint.password = "";
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint.toString().replace(/\/$/, "");
}

function accountNameFromEndpoint(endpoint) {
  const url = new URL(endpoint);
  const azureHost = url.hostname.toLowerCase().match(/^([a-z0-9]{3,24})\.blob\./);
  if (azureHost) return azureHost[1];
  if (url.hostname === "localhost" || /^[\d.]+$/.test(url.hostname)) {
    return url.pathname.split("/").filter(Boolean)[0]?.toLowerCase() ?? null;
  }
  return null;
}

export function summarizeStorageConnectionString(connectionString) {
  const fields = selectedConnectionFields(connectionString, STORAGE_KEYS);
  if (fields.get("usedevelopmentstorage")?.toLowerCase() === "true") {
    return {
      accountName: DEVELOPMENT_STORAGE_ACCOUNT,
      endpoint: `http://127.0.0.1:10000/${DEVELOPMENT_STORAGE_ACCOUNT}`,
    };
  }

  const explicitEndpoint = fields.get("blobendpoint");
  if (explicitEndpoint) {
    const endpoint = sanitizedEndpoint(explicitEndpoint);
    return {
      accountName: fields.get("accountname")?.toLowerCase() ?? accountNameFromEndpoint(endpoint),
      endpoint,
    };
  }

  const accountName = fields.get("accountname")?.toLowerCase() ?? null;
  if (!accountName) return { accountName: null, endpoint: null };
  const protocol = fields.get("defaultendpointsprotocol")?.toLowerCase() ?? "https";
  const suffix = fields.get("endpointsuffix")?.toLowerCase() ?? "core.windows.net";
  return {
    accountName,
    endpoint: `${protocol}://${accountName}.blob.${suffix}`,
  };
}

export function summarizeStorageAccount(accountName) {
  if (!STORAGE_ACCOUNT_PATTERN.test(accountName)) {
    throw new Error("Storage account name must be 3-24 lowercase letters or numbers");
  }
  return {
    accountName,
    endpoint: `https://${accountName}.blob.core.windows.net`,
  };
}

export function summarizeSqlConnectionString(connectionString) {
  const fields = selectedConnectionFields(connectionString, SQL_KEYS);
  return {
    server: fields.get("server") ?? fields.get("data source") ?? fields.get("address") ??
      fields.get("addr") ?? fields.get("network address") ?? null,
    database: fields.get("database") ?? fields.get("initial catalog") ?? null,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const connectionString = process.env.CONNECTION_STRING_TO_SUMMARIZE;
  if (!connectionString) throw new Error("CONNECTION_STRING_TO_SUMMARIZE is required");
  const mode = process.argv[2];
  if (mode !== "sql" && mode !== "storage") {
    throw new Error("summary mode must be sql or storage");
  }
  const summary = mode === "sql"
    ? summarizeSqlConnectionString(connectionString)
    : summarizeStorageConnectionString(connectionString);
  process.stdout.write(JSON.stringify(summary));
}
