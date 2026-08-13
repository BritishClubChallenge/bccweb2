# Privacy Runbook

Source of truth for the BCC PII redaction policy. All changes to this file require
a pull-request review by the data controller (project owner: Matt White).

## PII Redaction List

The canonical list lives in `scripts/lib/pii.mjs` (`PII_FIELDS` export).
The TypeScript port in `apps/api/src/lib/telemetryRedactor.ts` maintains an
identical copy — both files must be updated together.

Current fields:

| Field | Category |
|---|---|
| `email` | Contact |
| `password` | Credentials |
| `passwordHash` | Credentials |
| `phoneNumber` | Contact |
| `bhpaNumber` | Identity |
| `medicalInfo` | Health |
| `emergencyContactName` | Contact |
| `emergencyPhoneNumber` | Contact |
| `userAgent` | Fingerprinting |
| `ip` | Fingerprinting |
| `Authorization` | Auth tokens |
| `JWT` | Auth tokens |
| `jwt` | Auth tokens |
| `accessToken` | Auth tokens |
| `refreshToken` | Auth tokens |
| `verifyToken` | Auth tokens |
| `resetToken` | Auth tokens |
| `helmetColour` | Equipment |
| `harnessType` | Equipment |
| `harnessColour` | Equipment |
| `wingModel` | Equipment |
| `wingClass` | Equipment |
| `wingColours` | Equipment |

## Storage Identity Baseline

Azure environment stamps are secure by default: the Function UMI is the workload identity,
Shared Key is disabled on both storage accounts unconditionally, and there are no identity
or Shared Key toggle variables. Each stamp requires `operator_principal_id`, the object ID
of that environment's GitHub OIDC UMI, for approved remote operator access. Local Azurite
continues to use connection strings. Production remains undeployed; it receives this model
when first applied rather than being treated as already keyless.

The staging cutover is one `environment/staging` apply through the manual `terraform.yml`
workflow (or a local apply) followed by an application redeploy; a brief interruption is
acceptable. A plain `git revert` of the secure-storage change is not a safe rollback —
Azure does not reset `allowSharedKeyAccess` just because Terraform stops managing it.
Recovery re-enables Shared Key deliberately, before restoring key-based Function
settings and redeploying the prior artifact, never by changing storage authentication
modes manually — see
[../../iac/README.md](../../iac/README.md#staging-storage-cutover-and-rollback).

## Exception Process

Any whitelist exception (a PII field permitted in a specific public location)
requires:

1. A written justification explaining the legal basis (consent, legitimate interest,
   or legal obligation under UK GDPR Article 6).
2. Named approver (must be the data controller: Matt White).
3. A new entry in the table below committed to this file via PR.

### Current Exceptions

| Field | Location | Justification | Approved by | Date |
|---|---|---|---|---|
| `wingClass` | `results/{year}.json` — `teamResults[].pilots[].wingClass` | EN A/B/C/D is a competition scoring category used to compute the wing-factor multiplier. It is part of the official public competition record (RoundResult interface) and does not identify an individual — it is equivalent to a sport classification. Required for public scoring transparency. | Matt White | 2026-06-09 |

If adding a new exception, append a row with the format:

| Field | Location | Justification | Approved by | Date |
|---|---|---|---|---|

## How to Run the Scanner Locally

Requires Azurite running (`docker compose up azurite`) and containers initialised:

```sh
node scripts/init-storage.mjs

# Scan against local Azurite explicitly:
BLOB_CONNECTION_STRING="UseDevelopmentStorage=true" node scripts/privacy-scan.mjs

# Scan remote staging with the invoking Entra identity (separate approved grant required
# for a local human; persistent operator roles belong to the environment OIDC UMI):
az login
BLOB_STORAGE_ACCOUNT_NAME="stbccwebstagingdata" node scripts/privacy-scan.mjs

# Include bundle regex scan (add fixture emails/phones from test data):
node scripts/privacy-scan.mjs --bundle-patterns "test@example\.com,\+447\d+"
```

The scanner exits 0 on a clean pass, 1 if any violation is found.
Output lines are prefixed `[PASS]`, `[SKIP]`, or `[FAIL]`.

## How to Add a New Redaction Field

1. Add the field name to `PII_FIELDS` in `scripts/lib/pii.mjs`.
2. Add the identical field name to `PII_FIELDS` in `apps/api/src/lib/telemetryRedactor.ts`.
3. Add a row to the table above.
4. Run `node scripts/privacy-scan.mjs` and verify it still exits 0 (the new field
   should not appear in any public blob).
5. Run `npm test` from the workspace root to verify the telemetry redactor tests pass.
6. Commit both files together in the same PR.

## CI Integration

The privacy scanner runs automatically on every PR and push to `main` via
`.github/workflows/privacy-scan.yml`. It spins up Azurite as a service container,
seeds known-good test blobs, and runs `node scripts/privacy-scan.mjs`. A non-zero
exit fails the workflow and blocks the merge.

## What Is Preserved vs. Anonymised

| Data | Action |
|---|---|
| `PilotSummary.name` in `pilots.json` (public) | Replaced with `[REDACTED]` at GDPR erasure time |
| Private pilot blob (`pilots/{id}.json`) PII fields | Nulled/replaced — see GDPR Erasure Runbook |
| League positions (`seasons/{year}.json`) | Preserved (historical record) |
| Round results (`results/{year}.json`) | Preserved (historical record) |
| Signature audit trail (`signatures/...`) | Preserved (legal obligation) |
| `rounds/{id}.json` PilotSnapshot | Preserved at locked values; live pilot shows `[REDACTED]` |
| `users/{id}.json` and `auth/{id}.json` | Deleted at GDPR erasure time |
| `user-index.json` email entry | Removed at GDPR erasure time |

See `docs/runbooks/gdpr-erasure.md` for the full GDPR right-to-erasure procedure.

### Orphaned IGC Retention

A hard process termination after an IGC upload but before its round commit can leave an
unreferenced raw GPS-track blob under `flight-igcs/`. Periodically, and after a suspected
upload incident, run `node scripts/admin/reconcile-orphan-igcs.mjs` to review private IGC
blobs that no authoritative `rounds/*.json` blob references and that are older than the
default 24-hour safety threshold. Review the dry-run output first, then rerun with
`--delete`; use `--older-than-hours <hours>` only when a different safety window is
operationally justified. The script never deletes a referenced blob and refreshes the
round reference set immediately before deletion.

For remote staging, authenticate with `az login` and export
`BLOB_STORAGE_ACCOUNT_NAME=stbccwebstagingdata` before either dry run or delete. Do not
use a remote storage connection string or the Function App UMI. Persistent operator
roles belong to the environment OIDC UMI; a local human needs a separately approved grant.
For local Azurite, retain
`BLOB_CONNECTION_STRING="UseDevelopmentStorage=true"`.

## FAI Signature Validation: Outbound PII Egress

`apps/api/src/lib/faiVali.ts` (`validateIgcSignature`) uploads the raw IGC file for a
flight to the FAI online validator (`https://vali.fai-civl.org` by default, overridable
via `FAI_VALI_BASE_URL`) whenever `flightSignatureValidationEnabled` is on and a pilot
uploads or revalidates an IGC track. This is a genuine outbound PII egress: an IGC file's
`HFPLT` header carries the pilot's name, and its `B`-record track log is the pilot's GPS
flight path for that round. Both leave BCC's infrastructure and reach a third-party
service outside our control.

- **Scanner limitation**: `scripts/privacy-scan.mjs` only scans blobs written into the
  `data` (public) container. It has no visibility into this outbound HTTP call, so it
  cannot catch a regression that widens what gets sent to FAI or that sends flights that
  should have been exempted. Any change to `faiVali.ts` or its callers needs a manual
  privacy review; it is not covered by CI.
- **Disable controls**: setting the app setting `FAI_VALI_ENABLED=false` makes
  `validateIgcSignature` return `{signature: "unverified", faiStatus: "DISABLED"}`
  immediately, without any network call, regardless of the `config.json` toggle below.
  This is the hard kill switch for the outbound call itself (see
  `apps/api/local.settings.example.json`).
- **Feature toggle** (`config.json` → `flightSignatureValidationEnabled`, admin-editable
  via the Config page): turning this off does not retroactively re-score already-Complete
  rounds: a round's published score only changes on an explicit rescore
  (`POST /api/rounds/{id}/rescore`), which re-runs `scoreRoundEnforcingValidation`. To
  apply a toggle flip to a round's score, rescore it. `POST /api/manage/rounds/{id}/recompute`
  (`apps/api/src/functions/admin.ts`, backed by `apps/api/src/lib/recompute.ts`) does NOT
  re-score anything: it only republishes `rounds.json` and the season/results blobs from
  the round's already-persisted `team.score` values, so it cannot apply a toggle flip on
  its own. Use recompute only to recover from a failed publish, for example a season
  recompute that errored after a rescore had already correctly persisted the new score;
  running recompute again then republishes that already-correct score.
- **Queued jobs and the toggle**: disabling `flightSignatureValidationEnabled` does not
  purge jobs already sitting on the `igc-validation` queue. The `igcValidationWorker`
  re-reads `config.json` immediately before each FAI call, after acquiring the global
  guard, pacing, downloading the IGC, and re-checking the current flight attempt. If the
  toggle has since been switched off, the worker records `unverified`/`DISABLED` without
  sending the IGC to FAI. A call already past that final check remains in flight and can
  still complete; disabling the toggle does not cancel an outbound request that has
  already started.
- **Recovering a stuck pending validation**: a hard process termination after the round
  commits `signature: "pending"` but before the queue send can leave a flight with no
  worker. Recover one flight with the operator **Resubmit** action, which creates a fresh
  attempt and enqueues it. For bulk recovery, first review the dry run with
  `node scripts/admin/redispatch-stuck-igc-validations.mjs`, then run
  `node scripts/admin/redispatch-stuck-igc-validations.mjs --redispatch`. The script
  protects rounds modified within the default two-hour window, skips terminal signatures
  and attempts that already have a durable result, and reuses each eligible flight's
  existing attempt ID. Per the approved policy, a `pending` flight continues to score in
  the interim, including if the round completes before recovery.
  Remote staging execution requires `az login`,
  `BLOB_STORAGE_ACCOUNT_NAME=stbccwebstagingdata`, and
  `RUNTIME_STORAGE_ACCOUNT_NAME=stbccwebstagingrt` because it reads blobs and sends a
  queue message. Local Azurite keeps `BLOB_CONNECTION_STRING="UseDevelopmentStorage=true"`
  and `AzureWebJobsStorage="UseDevelopmentStorage=true"`.
- **Changing a round's date**: `updateRound` clears any stale `IGC_DATE_MISMATCH`
  sanity flag and drops the flight's stored date verdict when the round date changes, but
  it does not re-parse the IGC file. It only re-scores existing distances against the new
  date verdicts that already exist. A flight that becomes newly mismatched against the
  new date is not detected until you explicitly rescore the round
  (`POST /api/rounds/{id}/rescore`). After editing a round's date, rescore the round so
  IGC date validation is checked against the new date.
