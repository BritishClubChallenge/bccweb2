# E2E Tests (Playwright)

Browser-level smoke and integration tests against the running dev stack.

## One-shot browser install

```sh
npx playwright install --with-deps chromium
```

If `--with-deps` requires sudo (Linux CI), use the plain form instead:

```sh
npx playwright install chromium
```

## Start the dev stack

Start Azurite (Azure Storage emulator) in the background, then create its
containers/queues:

```sh
make azurite &
until curl -s -o /dev/null "http://127.0.0.1:10000/devstoreaccount1?comp=list"; do sleep 1; done
node scripts/init-storage.mjs
```

Start the API (Azure Functions) in the background:

```sh
npm run start --workspace @bccweb/api &
```

Start the web dev server in the background:

```sh
npm run dev --workspace @bccweb/web &
```

Wait until the API health endpoint responds before running tests:

```sh
until curl -sf http://localhost:7071/api/health; do sleep 2; done
```

The web dev server defaults to `http://localhost:5173`. Override via:

```sh
export E2E_BASE_URL=http://localhost:5173
```

## Run tests

```sh
npm run e2e
```

This runs `playwright test --config tests/e2e/playwright.config.ts`.

## Cleanup

```sh
pkill -f 'func start'
pkill -f 'vite'
pkill -f 'azurite'
```

## Evidence

- Screenshots are written to `.omo/evidence/` during test runs.
- HTML report is written to `tests/e2e/playwright-report/` (gitignored).

## Notes

- Only `chromium-desktop` project is configured (Chromium / Desktop Chrome).
- The `webServer` block is intentionally absent — the dev stack is started manually before running tests.
- Wave 6 (Task 45) will add full sign-to-fly journey tests once the feature is complete.
