#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
#
# Usage (BACPAC-specific connection-string mode):
#   BACPAC_PATH='...' BACPAC_TARGET_CONN='...' BACPAC_BLOB_CONN='...' \
#     scripts/migrate/validate-against-bacpac.sh
# Usage (shared staging connection-string mode):
#   BACPAC_PATH='...' BACPAC_TARGET_CONN='...' STAGING_BLOB_CONN='...' \
#     scripts/migrate/validate-against-bacpac.sh
# Usage (BACPAC-specific operator/OIDC identity mode):
#   BACPAC_PATH='...' BACPAC_TARGET_CONN='...' BACPAC_BLOB_ACCOUNT='accountname' \
#     scripts/migrate/validate-against-bacpac.sh
# Usage (shared staging operator/OIDC identity mode):
#   BACPAC_PATH='...' BACPAC_TARGET_CONN='...' STAGING_BLOB_ACCOUNT='accountname' \
#     scripts/migrate/validate-against-bacpac.sh
#
# Auth precedence is BACPAC_BLOB_CONN, STAGING_BLOB_CONN, BACPAC_BLOB_ACCOUNT,
# then STAGING_BLOB_ACCOUNT. Connection strings therefore win over identity.
# With none set, the existing local Azurite connection-string default is used.
# Use --print-config to validate the selected downstream configuration without
# contacting SQL or Azure; connection strings are masked in this output.

set -euo pipefail

SKIP_MESSAGE="SKIP: bacpac validation (set BACPAC_PATH + install sqlpackage to run)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SCHEMAS_DIST="$REPO_ROOT/packages/schemas/dist/index.js"
AZURITE_CONNECTION_STRING="DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;"

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

mask_connection_string() {
  node -e '
    const value = process.argv[1] || "";
    console.log(value
      .replace(/Password=[^;]+/gi, "Password=***")
      .replace(/AccountKey=[^;]+/gi, "AccountKey=***")
      .replace(/SharedAccessSignature=[^?&"\x27\s]+/gi, "SharedAccessSignature=***"));
  ' "${1:-}"
}

BACPAC_BLOB_CONN_VALUE="${BACPAC_BLOB_CONN:-${STAGING_BLOB_CONN:-}}"
BACPAC_BLOB_ACCOUNT_VALUE="${BACPAC_BLOB_ACCOUNT:-${STAGING_BLOB_ACCOUNT:-}}"
BACPAC_BLOB_AUTH_SOURCE=""
if [[ -n "${BACPAC_BLOB_CONN:-}" ]]; then
  BACPAC_BLOB_AUTH_SOURCE="BACPAC_BLOB_CONN precedence"
elif [[ -n "${STAGING_BLOB_CONN:-}" ]]; then
  BACPAC_BLOB_AUTH_SOURCE="STAGING_BLOB_CONN precedence"
elif [[ -n "${BACPAC_BLOB_ACCOUNT:-}" ]]; then
  BACPAC_BLOB_AUTH_SOURCE="BACPAC_BLOB_ACCOUNT precedence"
elif [[ -n "${STAGING_BLOB_ACCOUNT:-}" ]]; then
  BACPAC_BLOB_AUTH_SOURCE="STAGING_BLOB_ACCOUNT"
else
  BACPAC_BLOB_CONN_VALUE="$AZURITE_CONNECTION_STRING"
  BACPAC_BLOB_AUTH_SOURCE="Azurite default"
fi

with_staging_blob_auth() {
  if [[ -n "$BACPAC_BLOB_CONN_VALUE" ]]; then
    env -u BLOB_STORAGE_ACCOUNT_NAME BLOB_CONNECTION_STRING="$BACPAC_BLOB_CONN_VALUE" "$@"
  else
    env -u BLOB_CONNECTION_STRING BLOB_STORAGE_ACCOUNT_NAME="$BACPAC_BLOB_ACCOUNT_VALUE" "$@"
  fi
}

print_config() {
  local selected_config target
  if [[ -n "$BACPAC_BLOB_CONN_VALUE" ]]; then
    target="$(mask_connection_string "$BACPAC_BLOB_CONN_VALUE")"
    selected_config="$(with_staging_blob_auth node -e '
      const connection = Reflect.get(process.env, "BLOB_CONNECTION_STRING");
      const account = Reflect.get(process.env, "BLOB_STORAGE_ACCOUNT_NAME");
      if (!connection || account) process.exit(1);
      process.stdout.write("BLOB_CONNECTION_STRING=" + process.argv[1] + "; BLOB_STORAGE_ACCOUNT_NAME=<unset>");
    ' "$target")"
    printf 'Selected BACPAC blob auth: connection string (%s)\n' "$BACPAC_BLOB_AUTH_SOURCE"
    printf 'Blob target: %s\n' "$target"
    printf 'Container setup env: %s\n' "$selected_config"
    printf 'Migration env: %s\n' "$selected_config"
    printf 'Validation env: %s\n' "$selected_config"
    printf 'Cleanup env: %s\n' "$selected_config"
    printf 'Privacy scan: --source %s; BLOB_STORAGE_ACCOUNT_NAME=<unset>\n' "$target"
  else
    selected_config="$(with_staging_blob_auth node -e '
      const connection = Reflect.get(process.env, "BLOB_CONNECTION_STRING");
      const account = Reflect.get(process.env, "BLOB_STORAGE_ACCOUNT_NAME");
      if (connection || !account) process.exit(1);
      process.stdout.write("BLOB_STORAGE_ACCOUNT_NAME=" + account + "; BLOB_CONNECTION_STRING=<unset>");
    ')"
    printf 'Selected BACPAC blob auth: identity (DefaultAzureCredential; %s)\n' "$BACPAC_BLOB_AUTH_SOURCE"
    printf 'Blob target: account=%s (DefaultAzureCredential)\n' "$BACPAC_BLOB_ACCOUNT_VALUE"
    printf 'Container setup env: %s\n' "$selected_config"
    printf 'Migration env: %s\n' "$selected_config"
    printf 'Validation env: %s\n' "$selected_config"
    printf 'Cleanup env: %s\n' "$selected_config"
    printf 'Privacy scan env: %s; --source omitted\n' "$selected_config"
  fi
}

PRINT_CONFIG=false
if [[ "${1:-}" == "--print-config" ]]; then
  PRINT_CONFIG=true
  shift
fi
if (( $# > 0 )); then
  fail "unexpected argument: $1"
fi

if [[ "$PRINT_CONFIG" == true ]]; then
  print_config
  exit 0
fi

if [[ -z "${BACPAC_PATH:-}" || ! -f "${BACPAC_PATH:-}" ]] || ! command -v sqlpackage >/dev/null 2>&1; then
  printf '%s\n' "$SKIP_MESSAGE"
  exit 0
fi

drop_throwaway_database() {
  if [[ "${BACPAC_KEEP_TARGET_DB:-}" == "1" ]]; then
    printf 'Keeping BACPAC target DB because BACPAC_KEEP_TARGET_DB=1.\n' >&2
    return
  fi

  (
    cd "$REPO_ROOT/scripts/migrate"
    TARGET_CONN="$BACPAC_TARGET_CONN" node --input-type=module - <<'NODE'
import sql from "mssql";

const targetConn = process.env.TARGET_CONN;

function parts(connectionString) {
  return connectionString
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf("=");
      if (index === -1) return [part, ""];
      return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
    });
}

function databaseName(connectionString) {
  for (const [key, value] of parts(connectionString)) {
    const normalized = key.toLowerCase();
    if (normalized === "database" || normalized === "initial catalog") return value;
  }
  return null;
}

function masterConnectionString(connectionString) {
  let replaced = false;
  const rewritten = parts(connectionString).map(([key, value]) => {
    const normalized = key.toLowerCase();
    if (normalized === "database" || normalized === "initial catalog") {
      replaced = true;
      return `${key}=master`;
    }
    return `${key}=${value}`;
  });
  if (!replaced) rewritten.push("Database=master");
  return `${rewritten.join(";")};`;
}

function quoteIdentifier(value) {
  return `[${value.replaceAll("]", "]]")}]`;
}

const db = databaseName(targetConn);
if (!db || ["master", "msdb", "model", "tempdb"].includes(db.toLowerCase())) {
  console.error("Could not derive a safe throwaway database name from BACPAC_TARGET_CONN; skipping DB drop.");
  process.exit(0);
}

const pool = await sql.connect(masterConnectionString(targetConn));
try {
  const quoted = quoteIdentifier(db);
  await pool.request().batch(`
    IF DB_ID(N'${db.replaceAll("'", "''")}') IS NOT NULL
    BEGIN
      ALTER DATABASE ${quoted} SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
      DROP DATABASE ${quoted};
    END
  `);
  console.error(`Dropped throwaway database ${db}.`);
} finally {
  await pool.close();
}
NODE
  ) || printf 'WARN: throwaway DB teardown failed; drop it manually from BACPAC_TARGET_CONN.\n' >&2
}

cleanup() {
  local status=$?
  set +e
  if [[ -n "${PUBLIC_CONTAINER:-}" && -n "${PRIVATE_CONTAINER:-}" ]]; then
    (
      cd "$REPO_ROOT/scripts/migrate"
      with_staging_blob_auth env \
        PUBLIC_CONTAINER="$PUBLIC_CONTAINER" \
        PRIVATE_CONTAINER="$PRIVATE_CONTAINER" \
        node --input-type=module - <<'NODE'
import { createBlobServiceClient } from "./blobClient.mjs";

const svc = createBlobServiceClient();
await svc.getContainerClient(process.env.PUBLIC_CONTAINER).deleteIfExists();
await svc.getContainerClient(process.env.PRIVATE_CONTAINER).deleteIfExists();
NODE
    )
  fi
  if [[ -n "${BACPAC_TARGET_CONN:-}" ]]; then
    drop_throwaway_database
  fi
  if [[ -n "${TMP_DIR:-}" ]]; then
    rm -rf "$TMP_DIR"
  fi
  exit "$status"
}

trap cleanup EXIT

if [[ ! -f "$SCHEMAS_DIST" ]]; then
  fail "the built schemas package is absent at packages/schemas/dist/index.js; run make build before validate-bacpac"
fi

if [[ -z "${BACPAC_TARGET_CONN:-}" ]]; then
  fail "BACPAC_TARGET_CONN is required so sqlpackage can restore the bacpac to a throwaway database"
fi

BACPAC_PATH_ABS="$(cd "$(dirname "$BACPAC_PATH")" && pwd)/$(basename "$BACPAC_PATH")"
RUN_ID="$(date +%Y%m%d%H%M%S)-$$"
PUBLIC_CONTAINER="bacpac-public-$RUN_ID"
PRIVATE_CONTAINER="bacpac-private-$RUN_ID"
TMP_DIR="${TMPDIR:-/tmp}/bcc-bacpac-validate-$RUN_ID"
mkdir -p "$TMP_DIR"

printf '=== BCC BACPAC migration validation ===\n'
printf 'BACPAC: %s\n' "$BACPAC_PATH_ABS"
printf 'SQL target: %s\n' "$(mask_connection_string "$BACPAC_TARGET_CONN")"
if [[ -n "$BACPAC_BLOB_CONN_VALUE" ]]; then
  printf 'Blob target: %s\n' "$(mask_connection_string "$BACPAC_BLOB_CONN_VALUE")"
else
  printf 'Blob target: account=%s (DefaultAzureCredential)\n' "$BACPAC_BLOB_ACCOUNT_VALUE"
fi
printf 'Public container: %s\n' "$PUBLIC_CONTAINER"
printf 'Private container: %s\n' "$PRIVATE_CONTAINER"
printf 'State dir: %s/.migration-state\n\n' "$TMP_DIR"

printf 'Step 1/6: restoring BACPAC to throwaway DB with sqlpackage...\n'
sqlpackage /Action:Import /SourceFile:"$BACPAC_PATH_ABS" /TargetConnectionString:"$BACPAC_TARGET_CONN"

printf 'Step 2/6: creating fresh throwaway blob containers...\n'
(
  cd "$REPO_ROOT/scripts/migrate"
  with_staging_blob_auth env \
    PUBLIC_CONTAINER="$PUBLIC_CONTAINER" \
    PRIVATE_CONTAINER="$PRIVATE_CONTAINER" \
    node --input-type=module - <<'NODE'
import { createBlobServiceClient } from "./blobClient.mjs";

const svc = createBlobServiceClient();
await svc.getContainerClient(process.env.PUBLIC_CONTAINER).createIfNotExists({ access: "blob" });
await svc.getContainerClient(process.env.PRIVATE_CONTAINER).createIfNotExists();
NODE
)

printf 'Step 3/6: running migrate.mjs for real (no --dry-run) against throwaway blobs...\n'
(
  cd "$TMP_DIR"
  with_staging_blob_auth env \
    SQL_CONNECTION_STRING="$BACPAC_TARGET_CONN" \
    BLOB_CONTAINER="$PUBLIC_CONTAINER" \
    BLOB_PRIVATE_CONTAINER="$PRIVATE_CONTAINER" \
    DRY_RUN=0 \
    PRODUCTION_CONFIRM=YES \
    node "$REPO_ROOT/scripts/migrate/migrate.mjs" --force-production
)

printf 'Step 4/6: running validate.mjs schema gate against both produced containers...\n'
(
  cd "$TMP_DIR"
  with_staging_blob_auth env \
    BLOB_CONTAINER_NAME="$PUBLIC_CONTAINER" \
    BLOB_PRIVATE_CONTAINER_NAME="$PRIVATE_CONTAINER" \
    node "$REPO_ROOT/scripts/migrate/validate.mjs"
)

printf 'Step 5/6: running reconcile.mjs and asserting no anomalies...\n'
(
  cd "$TMP_DIR"
  node "$REPO_ROOT/scripts/migrate/reconcile.mjs"
)

printf 'Step 6/6: running privacy-scan.mjs against the public throwaway container...\n'
(
  cd "$TMP_DIR"
  if [[ -n "$BACPAC_BLOB_CONN_VALUE" ]]; then
    with_staging_blob_auth env BLOB_CONTAINER_NAME="$PUBLIC_CONTAINER" \
      node "$REPO_ROOT/scripts/privacy-scan.mjs" --source "$BACPAC_BLOB_CONN_VALUE"
  else
    with_staging_blob_auth env BLOB_CONTAINER_NAME="$PUBLIC_CONTAINER" \
      node "$REPO_ROOT/scripts/privacy-scan.mjs"
  fi
)

printf '\nBACPAC validation PASSED: real migration blobs satisfy schema gate, reconcile, and privacy scan.\n'
