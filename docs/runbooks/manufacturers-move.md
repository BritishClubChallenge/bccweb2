# Manufacturers Reference Data — Private→Public Move

`manufacturers.json` carries no PII (fields: `id`, `legacyId`, `name`, `websiteUrl` only)
and the SPA reads it directly. It was originally written to `data-private` and must be
moved to the public `data` container **once**, after the Function App deploy that begins
writing it publicly.

## When to run

Run `move-manufacturers-to-public.mjs` **immediately after** the Function App deploy
that includes the manufacturers API changes. The deploy switches the API to write
`manufacturers.json` to the public container going forward; this script performs the
one-time promotion of the existing private copy.

## Script

Remote staging uses the invoking Entra identity, not a storage key or the Function UMI:

```bash
az login
BLOB_STORAGE_ACCOUNT_NAME="stbccwebstagingdata" \
  node scripts/admin/move-manufacturers-to-public.mjs
```

Persistent operator storage roles belong to the staging OIDC UMI. A local human needs a
separately approved data-plane grant. For local Azurite, retain the explicit emulator
path:

```bash
BLOB_CONNECTION_STRING="UseDevelopmentStorage=true" \
  node scripts/admin/move-manufacturers-to-public.mjs
```

Optional flag:

```bash
BLOB_STORAGE_ACCOUNT_NAME="stbccwebstagingdata" \
  node scripts/admin/move-manufacturers-to-public.mjs --force
```

`--force` overwrites a conflicting non-empty public list. Only required if a non-empty
`manufacturers.json` already exists in the public container with different content than
the private source of truth.

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `BLOB_CONNECTION_STRING` | Azurite dev | Local emulator connection string; takes precedence and must not carry a remote account key |
| `BLOB_STORAGE_ACCOUNT_NAME` | — | Remote data account; uses the invoking Entra identity |
| `BLOB_CONTAINER_NAME` | `data` | Public container |
| `BLOB_PRIVATE_CONTAINER_NAME` | `data-private` | Private container (source of truth) |

## What the script does

The script is **idempotent** — safe to run multiple times. It follows this sequence:

1. **Read private blob** (`data-private/manufacturers.json`). If absent (i.e. the move
   was already completed on a previous run), exit 0 immediately — no-op success.

2. **Validate the full list** against `ManufacturersIndexSchema` before any write.
   Invalid JSON or a schema violation causes a nonzero abort — both blobs are left
   untouched.

3. **Inspect the public blob** (`data/manufacturers.json`) and decide:
   - **Absent or `[]`** → write the validated private list to the public container.
   - **Byte-identical** to what the script would write → skip the public write; the
     move was already reflected publicly (interrupted previous run). Proceed to deletion.
   - **Non-empty and different** → abort nonzero with exit code 2, both blobs untouched.
     Use `--force` to overwrite.

4. **Verify the write** by reading the public blob back and comparing bytes. If the
   read-back does not match, abort nonzero (exit code 3) and leave the private copy
   **intact** for safety.

5. **Delete the private copy** (`data-private/manufacturers.json`) only after the public
   blob is confirmed correct. The private blob's absence is the idempotency signal for
   future runs.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success or no-op (private blob already absent) |
| `1` | Invalid JSON or schema validation failure — both blobs untouched |
| `2` | Conflict: public blob is non-empty and differs from private; use `--force` |
| `3` | Public write verification failed (read-back mismatch) — private copy preserved |

## Capture evidence

After a successful run, append the script output to the evidence file:

```bash
BLOB_STORAGE_ACCOUNT_NAME="stbccwebstagingdata" \
  node scripts/admin/move-manufacturers-to-public.mjs \
  | tee -a .omo/evidence/task-11-manufacturers-reference-data.txt
echo "EXIT: $?" >> .omo/evidence/task-11-manufacturers-reference-data.txt
```

## Privacy scan

After the move, verify the public container remains PII-free:

```bash
BLOB_STORAGE_ACCOUNT_NAME="stbccwebstagingdata" node scripts/privacy-scan.mjs
```

The scanner must exit 0. `manufacturers.json` is safe in the public container because
none of its fields (`id`, `legacyId`, `name`, `websiteUrl`) are in the PII watch-list.
