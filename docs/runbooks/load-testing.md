# Load Testing Runbook

Use this runbook for an operator-owned, dedicated load-test stack. The suite measures
round-blob contention without client replay and proves exact Sign-to-Fly persistence
before destructive cleanup. Never target production or a shared queue.

## Storage identity baseline

Azure environment stamps unconditionally use the Function UMI as their workload identity
and disable Shared Key on both storage accounts; there are no identity or Shared Key toggle
variables. The required per-environment `operator_principal_id` identifies that environment's
GitHub OIDC UMI for remote operator access. Local Azurite remains connection-string based.
Production is not deployed and must not be described as already keyless; it receives this
secure-by-default model when first applied.

Cut staging over with one `environment/staging` apply through the manual `terraform.yml`
workflow (or locally), then redeploy the application; a brief interruption is acceptable.
A plain `git revert` of the secure-storage change is not a safe rollback — Azure does not
reset `allowSharedKeyAccess` just because Terraform stops managing it. Recovery
re-enables Shared Key deliberately before restoring key-based Function settings and
redeploying the prior artifact — see
[../../iac/README.md](../../iac/README.md#staging-storage-cutover-and-rollback).

## Preconditions

1. Install k6 and start a worker-owned local stack or dedicated Azure test stack.
2. Seed canonical fixtures with `make seed`: it creates/reuses an ignored mode-0600
   `.dev-credentials` without logging the password, plus 500 pilots, 25 clubs, 50 teams, 10
   pilots/team, 25 `RoundsCoord` users, and 50 captain assignments. `make seed-rounds`
   is optional operator browsing data, not part of `make loadtest`.
3. Export `LOADTEST_DEDICATED_STACK=1`. Queue counts are approximate and global;
   cleanup permission is meaningful only when this suite owns the stack.
4. For Azure, set `BCC_API_BASE_URL` and `ADMIN_PASSWORD`, disable PureTrack/email,
   run `az login`, and export `BLOB_STORAGE_ACCOUNT_NAME=stbccwebstagingdata` plus
   `RUNTIME_STORAGE_ACCOUNT_NAME=stbccwebstagingrt`. Azure login remains limited to 10/min
   per trusted `client-ip`; local synthetic XFF partitioning does not bypass it.
   Remote hostnames must contain `loadtest` or `staging`; production-looking names
   fail before the orchestrator creates state or starts prepare.

```sh
make seed
export LOADTEST_DEDICATED_STACK=1
make loadtest
```

`make loadtest` invokes `scripts/run-loadtest.mjs` as one recipe. Make parallelism
cannot fan out or reorder its children. Narrow `make loadtest-*` targets remain for
controlled diagnosis; `make help` is the authoritative target list.

## Persisted status phases

The status artifact always contains these rows in this exact order:
`prepare/register/captains/transition/sign/artifact/verify/cleanup`.

1. **Prepare** — replace only a prior checkpoint-owned load round; create and
   checkpoint a +35-day Confirmed 50-team/500-slot round before adding teams.
2. **Register** — 500 setup logins in batches of 25, then 20 cohorts of 25 one-shot
   registrations at five-second intervals.
3. **Captains/reconcile** — 25 coordinator logins, 50 captain writes, authoritative
   place reconciliation, private atomic prepared-artifact replacement.
4. **Transition** — one request to `BriefComplete`.
5. **Sign** — one-shot cohorts 10/25/50/100 over offsets 0/10/35/85: 185 selected,
   315 deliberately unsigned.
6. **Artifact** — parse sign events/summary and require the exact first-write contract.
7. **Verify** — inspect exact ledger IDs and flags, replay exactly one persisted
   signature for the same ID, then require `signtofly-reflect` and poison approximate
   counts zero in two observations at least two seconds apart.
8. **Cleanup** — remove only the durable `loadRoundId` ownership set and its exact
   artifacts/references after its non-secret target-stack digest matches the current
   API/storage target.

Register and sign do not retry failed operations. Bounded setup may wait only for a
valid HTTP 429 `Retry-After`; permanent errors remain one attempt. Server lease
contention is handled by the production `withPrivateLeaseRetry` transaction, never by
k6 retry/sleep or a production bypass.

## Hard release gates

- Register: 500 attempts, 500 successes, zero failures, zero 5xx.
- Sign cohorts: exactly 10/25/50/100 attempts and creations, HTTP 201 only, zero
  errors/5xx, p95 <2,000 ms and p99 <5,000 ms for every cohort.
- Persisted result: 185 exact unique signatures and signed flags, final burst
  100/100, and all 315 non-target flags false.
- Replay: one HTTP 200 with the same persisted signature ID. A coherent persisted
  error key is preferred; otherwise output explicitly says `replay=fallback`.
- Queue: main=0 and poison=0, stable twice after replay on a dedicated stack.

For a loopback target, the host verifier uses the repository's queue-capable Azurite
default (`127.0.0.1:10001`) when `AzureWebJobsStorage` is not exported in the shell.
Remote targets must provide `AzureWebJobsStorage` or `RUNTIME_STORAGE_ACCOUNT_NAME`;
`BLOB_CONNECTION_STRING` remains blob-only and is never used for queue verification.
For remote staging, use account names with the invoking Entra identity, not remote storage
keys or the Function UMI. Persistent operator blob/queue roles belong to the environment OIDC
UMI; a local human needs a separately approved grant. Local Azurite remains explicit:
`BLOB_CONNECTION_STRING="UseDevelopmentStorage=true"` and
`AzureWebJobsStorage="UseDevelopmentStorage=true"`.

Each environment now provisions TWO storage accounts (see
`docs/architecture/storage-and-queues.md`): Account A (`stbccweb<env>rt`, e.g.
`stbccwebstagingrt`) is the `AzureWebJobsStorage` target — it holds all ten queues plus
the Flex Consumption deployment package — while Account B (`stbccweb<env>data`, e.g.
`stbccwebstagingdata`) is the application blob target holding `data`/`data-private`.
The queue gate above (main/poison quiescence) always inspects Account A; register/sign/
artifact HTTP traffic reads and writes Account B through the API. When targeting a real
Azure stack, resolve each account name from its own Terraform output — do not assume a
single combined account:

```bash
terraform -chdir=iac/environment output -raw storage_account_name_runtime  # Account A
terraform -chdir=iac/environment output -raw storage_account_name_data     # Account B
```

For the staging identity path the equivalent operator setup is:

```bash
az login
export BLOB_STORAGE_ACCOUNT_NAME="stbccwebstagingdata"
export RUNTIME_STORAGE_ACCOUNT_NAME="stbccwebstagingrt"
```

These gates are user-approved release criteria. Do not downgrade them to advisory
metrics to make a run pass.

## Failure transaction

The orchestrator writes phase state before and after every command with duration and
exact exit/signal/timeout. It captures stdout/stderr without a shell pipe and reports
all attempted/skipped outcomes, attempted state, skip reason, and safe log path.
Status JSON never contains command args/env, tokens,
passwords, bodies, or captured output.

| Observed failure | Required action |
| --- | --- |
| Prepare fails with no checkpoint | Stop. Do not invoke cleanup. |
| Prepare fails after create/checkpoint | Cleanup the exact owned round; aggregate remains failed. |
| Register/captains/transition fails | Skip dependants and cleanup exact owned state. Never retry the failed operation. |
| Sign k6 exits nonzero or is signalled | Still parse artifacts and run the exact verifier. Preserve the sign status in the aggregate. |
| Artifact parser fails | Still run the exact persisted verifier; parser and verifier statuses remain separate. |
| Exact verifier, replay, or queue gate fails | Return nonzero and preserve round/checkpoint/prepared/events/summary/logs. **Do not cleanup.** |
| Exact verifier and queue gate pass | Cleanup is permitted even when k6/artifact status failed; aggregate still returns nonzero. |
| Cleanup fails | Return nonzero and retain checkpoint ownership for a surgical retry. |

An interrupt terminates the active child with a signal and lets this same policy decide
safe follow-up. Every command has a finite timeout; a hung child receives SIGTERM and
then bounded SIGKILL escalation.

## Evidence and diagnosis

Ignored private artifacts live under `logs/load-test/`:

- `orchestration-<run>.json` — aggregate phase status/timing only;
- `<run>-<phase>.log` — captured child streams;
- sign event and summary JSON — count/key/status evidence, no credentials;
- `.loadtest-round-state.json` and `tests/load/.prepared-round.json` — mode-0600
  ownership and synthetic credential state.

The ownership checkpoint stores a SHA-256 digest of non-secret API/storage target
identifiers beside `loadRoundId` and non-empty browsing `seedRoundIds`. The digest includes
the API origin, storage and queue endpoints, and effective public/private blob container
names. Changing any target component with owned state fails before cleanup or ownership
clearing; restore the original target to recover it. Legacy owned checkpoints without a
target digest also fail closed rather than guessing ownership.

Phase status rows link to their private log paths. Artifact/status path overrides are
relative to, and confined beneath, `logs/load-test/`; absolute and parent paths fail
before execution.

On verifier/quiescence failure, retain all artifacts and inspect Function host logs,
the exact named slot/signature mismatch, and both reflect queues. Retry
`make loadtest-verify` with the retained `SIGN_EVENTS_PATH`/`SIGN_SUMMARY_PATH`; only
after a passing exact verifier may `make loadtest-cleanup` run.

On cleanup failure, fix storage access and rerun `make loadtest-cleanup`. Cleanup uses
the checkpoint, not prefix discovery, so interrupted runs remain recoverable and
unrelated fixtures/seed rounds survive.

## Azure configuration and cost controls

Use `PURETRACK_ENABLED=false`, leave `config.json` `roundBriefRecipients` empty (the
default) to disable brief email, a dedicated JWT secret and dedicated
storage accounts (both Account A/runtime and Account B/data), and non-production/omitted
ACS. Warm the health endpoint if cold-start
behavior is not the subject. Azure scale, storage leases, and authentication topology
differ from Azurite; record those differences with the result rather than weakening
gates.

## Contract CI

`npm run loadtest:test` runs deterministic Node/k6-source/orchestration/artifact
contracts. CI runs it after install/build without requiring k6, Azurite, or a live
Function host. Live load execution remains an explicit operator action.
