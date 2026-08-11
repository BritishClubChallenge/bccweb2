# Load Testing (k6)

The load suite exercises registration and Sign-to-Fly contention on a dedicated
stack. Never run it against production. `make loadtest` is one sequential Node
orchestrator process; even `make -j loadtest` cannot reorder its phases.

## Prerequisites

- Install k6 (`brew install k6`, a supported Linux package, or `grafana/k6`).
- Start an isolated local stack, or select a dedicated Azure load-test stack.
- Run `make seed` once. It creates/reuses the ignored mode-0600 `.dev-credentials`
  file without logging its value. `make seed-rounds` is optional browsing data and is not a
  load-pipeline phase. Seeding creates 500 pilots, 25 clubs, 50 canonical teams,
  10 pilots per team, 25 coordinators, and 50 captains.
- Set `LOADTEST_DEDICATED_STACK=1`. The exact verifier refuses global queue
  claims without this explicit confirmation.
- `ADMIN_PASSWORD` remains an explicit override; otherwise admin scripts use the
  generated `.dev-credentials`. Do not copy credentials into logs or evidence.

Remote authentication is intentionally limited: login is 10 requests/minute per
trusted client IP. Unique `X-Forwarded-For` values partition only local Functions
traffic; Azure uses its trusted `client-ip`. One remote generator therefore cannot
perform 500 setup logins without an approved partitioned-generator or token design.

## Persisted status phases

The status artifact always contains these rows in this exact order:
`prepare/register/captains/transition/sign/artifact/verify/cleanup`.

1. **Prepare** (`loadtest-prepare`) replaces any prior checkpointed load round,
   creates a +35-day Confirmed round with 50 teams/500 slots, and atomically writes
   `tests/load/.prepared-round.json`. The exact created round ID is checkpointed in
   `.loadtest-round-state.json` before team creation, paired with a non-secret digest
   of the current API/storage target. A target mismatch fails before cleanup or
   ownership clearing.
2. **Register** (`loadtest-register`) logs in 500 pilots in batches of 25, then runs
   twenty 25-VU one-shot cohorts five seconds apart. Each pilot sends one
   `/register-self`; the client never retries registration.
3. **Captains/reconcile** (`loadtest-captains`) logs in the 25 club coordinators,
   sets all 50 captains, reads authoritative places, and atomically rewrites the
   prepared artifact. Setup HTTP may honor bounded `Retry-After` 429 responses;
   captain operations never retry 409/5xx.
4. **Transition** (`loadtest-transition`) advances the prepared round to
   `BriefComplete` with one administrative request.
5. **Sign** (`loadtest-sign`) authenticates the selected 185 pilots and runs disjoint
   one-shot cohorts of 10, 25, 50, and 100 at prepared offsets 0, 10, 35, and 85.
   The other 315 slots remain unsigned. Signing never retries.
6. **Artifact** validates the k6 JSON/summary contract independently of k6 exit.
7. **Verify** (`loadtest-verify`) validates the exact 185-key ledger, 185 true flags, 315 false
   flags, final-100 IDs, and one same-ID HTTP 200 replay. A persisted errored key is
   replayed when coherent; otherwise the verifier labels a deterministic successful
   key `replay=fallback`. This phase also observes the dedicated `signtofly-reflect`
and poison queues through `AzureWebJobsStorage` or `RUNTIME_STORAGE_ACCOUNT_NAME`; it requires
   approximate global counts of zero twice at least two seconds apart after replay;
   it never peeks, dequeues, or treats this approximation as valid on a shared stack.
8. **Cleanup** (`loadtest-cleanup`) deletes only the checkpoint-owned round,
   signatures, briefs, and known references. It never scans for ownership and
   preserves fixtures and optional seed rounds.

The production server owns lease-conflict retry through `withPrivateLeaseRetry`.
The register and sign clients deliberately do not retry failed operations, so every
response remains visible in the result.

The host verifier defaults to the queue-capable local Azurite endpoint for loopback
runs. Dedicated remote runs must export `AzureWebJobsStorage` or
`RUNTIME_STORAGE_ACCOUNT_NAME`; blob-only `BLOB_CONNECTION_STRING` is never a queue fallback.

## Running

```sh
make seed
export LOADTEST_DEDICATED_STACK=1
make loadtest
```

For a dedicated Azure stack also set `BCC_API_BASE_URL` and `ADMIN_PASSWORD`, and
disable external effects (`PURETRACK_ENABLED=false`; leave `config.json`
`roundBriefRecipients` empty, the default, to disable brief email). Remote
hostnames must contain `loadtest` or `staging`; production-looking names are rejected
before any directory, checkpoint, or API mutation.

The narrow Make targets remain available for diagnosis. Run them in the phase order
above; `make help` lists prepare, register, captains, transition, sign, verify, and
cleanup. `artifact` is an internal status phase; the queue gate is inside `verify`.

## Gates and artifacts

Each sign cohort requires exactly its configured number of HTTP **201** creations,
zero errors/5xx, p95 below 2 seconds, and p99 below 5 seconds. These are hard,
user-approved release gates, not advisory baselines. HTTP 200 during first-write load
is a stale replay and fails. Register requires exactly 500 attempts/successes and zero
failures/5xx.

Runtime output is kept under ignored `logs/load-test/`: private per-phase logs, sign
events/summary, and `orchestration-<run>.json`. The status artifact records only phase
name, state, timing, exit code/signal/timeout, attempted/skip reason where applicable,
safe log path, and sanitized runner errors—never command
arguments, environment, credentials, request bodies, or child output. Its phase rows
include the corresponding safe log path. `SIGN_EVENTS_PATH`, `SIGN_SUMMARY_PATH`, and
`LOADTEST_STATUS_PATH` overrides must be relative paths beneath `logs/load-test/`.

## Failure and cleanup policy

| Failure point | Later work | Cleanup |
| --- | --- | --- |
| Prepare before a load-round checkpoint exists | Stop | Skip; nothing is owned |
| Prepare after checkpoint, register, captains, or transition | Skip dependent phases | Always attempt exact checkpoint cleanup |
| Sign/k6 or artifact parser | Run artifact/exact verifier as applicable; aggregate every status | Only when exact verifier and post-replay queue gate pass |
| Exact ledger/flags/replay or queue quiescence | Stop | **Forbidden**; preserve round, checkpoint, prepared file, events, summary, logs, and status |
| Cleanup | Report aggregate failure | Nonzero; checkpoint remains diagnostic/retry ownership |

An all-success run returns zero. Any child exit, signal, timeout, artifact failure,
verifier failure, status-write failure, or cleanup failure makes the aggregate result
nonzero. The final report distinguishes attempted, skipped, passed, and failed phases.

## Recovery

- After an exact verifier/queue failure, inspect the preserved status and phase logs,
  then rerun `make loadtest-verify` with the retained event/summary paths. Do not clean
  first.
- After a pre-sign failure, the orchestrator already attempted cleanup when ownership
  existed. If cleanup failed, fix the cause and run `make loadtest-cleanup`; exact
  checkpoint ownership makes interruption/resume surgical.
- `make loadtest-prepare` replaces a prior checkpoint-owned load round. It does not
  replace the four optional `make seed-rounds` rounds.
- k6 setup waits are bounded. A bad credential, missing token, setup timeout, 409, or
  5xx is surfaced rather than retried or masked.

Run the pure contract suite with `npm run loadtest:test`; CI runs it without k6 or
Azurite.
