# @bccweb/api

## Running tests

Tests run on [Vitest](https://vitest.dev). Run the API tests with:

- `npm test` (from `apps/api`) — runs `vitest run`
- `make test` (from repo root) — runs the full Vitest workspace
- `npx vitest run path/to/file.test.ts` — single file

Prerequisite:

- Start Azurite first: `make azurite` (from repo root; API tests create
  per-file Azurite containers and will fail without it).

### PureTrack integration tests (opt-in, live API)

These tests talk to the real BCC PureTrack account and are opt-in.

- Copy `apps/api/.env.example` → `apps/api/.env`, then fill in real PureTrack
  credentials plus `PURETRACK_TEST_PILOT_IDS` (comma-separated real numeric
  pilot IDs).
- Make sure Azurite is running and the machine can reach `puretrack.io`.
- Run `make test-integration` (equivalently,
  `VITEST_INTEGRATION=1 npx vitest run --project @bccweb/api`).

Warning: this creates throwaway PureTrack groups named `BCC …`, containing an
`ITEST-<runId>` marker in the site/team name, and deletes them in `afterAll`.

The suite self-skips when credentials are absent, and it is excluded from the
default `make test` path and from CI, so CI never needs PureTrack secrets.
