# GDPR Erasure Runbook

Procedure for honouring an Article 17 (right to erasure) request for a pilot
registered in the BCC system.

Data controller: Matt White (project owner).
This runbook must not be executed without explicit written authorisation.

## When to Run

Execute this procedure when:

1. A registered pilot submits a written right-to-erasure request under UK GDPR Article 17.
2. The data controller has verified the requester's identity.
3. The data controller has confirmed no statutory retention obligation overrides the request
   (e.g. the pilot's signatures are part of a safety audit record under CAA obligations;
   those records are preserved — see "What is preserved" below).
4. The data controller has issued written authorisation (email or letter) referencing the
   `pilotId` and the date of the request.

## Who Approves

Only the data controller (Matt White) may approve a GDPR erasure request.
No one else may run this script. The authorisation document must be retained for
at least 6 years alongside the audit log.

## Retention Timeline

| Event | Retention |
|---|---|
| Right-to-erasure request received | Record indefinitely |
| Authorisation document | 6 years minimum |
| Audit log (`.omo/evidence/gdpr/`) | 6 years minimum |
| Anonymised pilot blob | Retained (anonymised — no PII) |
| Deleted user / auth blobs | Immediately purged |

Blob soft-delete is configured (7-day window per IaC Task 6). After 7 days,
deleted blobs are unrecoverable. The window exists for operational rollback only;
it must not be used to restore an erased pilot without a new data-controller decision.

## What Is Anonymised

| Blob | Action |
|---|---|
| `pilots/{id}.json` (private) | `person.firstName`, `person.lastName`, `person.fullName` → `"[REDACTED]"` |
| `pilots/{id}.json` (private) | `person.phoneNumber`, `bhpaNumber`, `medicalInfo`, `emergencyContactName`, `emergencyPhoneNumber`, `helmetColour`, `harnessType`, `harnessColour`, `wingModel`, `wingColours` → `null` |
| `pilots/{id}.json` (private) | `userId` → `null` (unlinks account) |
| `pilots.json` (public) | `name` field in pilot index → `"[REDACTED]"` |
| `user-index.json` (private) | email→userId entry removed |
| `users/{userId}.json` (private) | blob deleted |
| `auth/{userId}.json` (private) | blob deleted |
| `auth/tokens/{hash}.json` (private) | deleted for any token belonging to this userId |

## What Is Preserved

| Blob | Reason |
|---|---|
| `rounds/{id}.json` — `PilotSnapshot` | Frozen at lock time; safety record under CAA obligation |
| `results/{year}.json` | Historical competition record; no PII in results |
| `seasons/{year}.json` | League table uses club/team names, not pilot PII |
| `signatures/{id}.json` | Legal audit trail of Sign-to-Fly consent |
| `round-briefs/{id}.json` | Safety brief document; anonymised name appears if live pilot is read |

## Running the Script

```sh
# 1. Confirm you have written authorisation and the pilotId.
# 2. Select the remote data account. DefaultAzureCredential uses your current
#    az login/OIDC identity; do not use the Function App managed identity.
az login
export BLOB_STORAGE_ACCOUNT_NAME="stbccwebstagingdata"

# 3. Set the confirmation guard.
export GDPR_ANONYMIZE_CONFIRM=YES

# 4. Run.
node scripts/admin/anonymize-pilot.mjs --pilotId <uuid> --confirm
```

Persistent operator storage roles belong to the staging OIDC UMI. A local human running
this procedure needs a separately approved data-plane grant. For authorised local
Azurite rehearsal, omit the account name and use
`BLOB_CONNECTION_STRING="UseDevelopmentStorage=true"`; never substitute a remote account
key.

The script will:
- Refuse to run without both `--confirm` and `GDPR_ANONYMIZE_CONFIRM=YES`.
- Log every blob it touches (field names only, never values) to stdout.
- Write an audit log to `.omo/evidence/gdpr/anonymize-{pilotId}-{date}.json`.

## Audit Trail Location

```
.omo/evidence/gdpr/anonymize-{pilotId}-{date}.json
```

The file records:
- `pilotId` and `userId` (UUIDs — not PII).
- Timestamp and operator (`$USER`).
- List of blobs touched and action taken.
- List of field names that were anonymised (NOT the values).
- List of blobs preserved.

Store the audit log alongside the requester's authorisation document.

## Rollback

The blob soft-delete window is 7 days (configured in IaC).
Rollback is only permissible if the erasure was accidental and the data controller
explicitly authorises recovery before the soft-delete window expires.

To recover a soft-deleted blob:

```sh
# Using Azure CLI:
az storage blob undelete \
  --account-name <storage-account> \
  --container-name data-private \
  --name "pilots/<uuid>.json"
```

If the 7-day window has passed, recovery is impossible and the erasure is permanent.

## Post-Execution Verification

After running the script, verify:

1. `node scripts/privacy-scan.mjs` still exits 0 (public blobs remain clean).
2. The public `pilots.json` shows `"[REDACTED]"` for the pilot name.
3. The private pilot blob exists (anonymised) but contains no PII values.
4. The audit log file exists at `.omo/evidence/gdpr/anonymize-{pilotId}-{date}.json`.
5. The authorisation document is filed alongside the audit log.
