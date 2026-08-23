# SPDX-FileCopyrightText: 2026 British Club Challenge authors
# SPDX-License-Identifier: MPL-2.0
.PHONY: help
help: ## Show this help
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  %-22s %s\n", $$1, $$2}' $(MAKEFILE_LIST) | sort

.PHONY: all
all: install build ## Install dependencies and build everything

.PHONY: install
install: ## Install npm dependencies
	npm install

.PHONY: build
build: build-types build-schemas build-scoring build-api build-web ## Build all packages in dependency order

.PHONY: build-types
build-types: ## Build shared types package
	npm run build --workspace=packages/types

.PHONY: build-schemas
build-schemas: build-types ## Build schemas package
	npm run build --workspace=packages/schemas

.PHONY: build-scoring
build-scoring: build-types ## Build scoring package
	npm run build --workspace=packages/scoring

.PHONY: build-api
build-api: build-types build-schemas build-scoring ## Build Azure Functions API
	npm run build --workspace=apps/api

.PHONY: build-web
build-web: build-types build-schemas ## Build React SPA
	npm run build --workspace=apps/web

.PHONY: typecheck
typecheck: ## Typecheck all workspaces (incl. test-only tsconfig where present)
	npm run typecheck --workspaces --if-present
	npm run test:typecheck --workspaces --if-present

.PHONY: test
test: ## Run all tests (requires Azurite for API tests)
	npx vitest run

# Run the heavy/slow API lib tests excluded from 'make test'. Records runtime.
.PHONY: test-heavy
test-heavy:
	VITEST_HEAVY=1 npx vitest run --project @bccweb/api

.PHONY: test-integration
test-integration: ## Run opt-in PureTrack LIVE-API integration tests (needs apps/api/.env + Azurite + network; self-skips without creds)
	VITEST_INTEGRATION=1 npx vitest run --project @bccweb/api

.PHONY: validate-bacpac
validate-bacpac: ## Real BACPAC validation via blob connection/account identity; defaults Azurite, self-skips without BACPAC_PATH/sqlpackage
	scripts/migrate/validate-against-bacpac.sh

.PHONY: dev
dev: ## Start full local dev stack natively (Azurite + API + Web); Ctrl-C stops everything
	node scripts/dev-stack.mjs

.PHONY: azurite
azurite: ## Start Azurite natively (no Docker); for standalone use in the 3-terminal workflow
	npx azurite --location .azurite --skipApiVersionCheck

.PHONY: dev-api
dev-api: build-types build-scoring build-api ## Start Azure Functions host (requires Azurite: make azurite)
	node scripts/init-storage.mjs
	node scripts/seed-admin.mjs --prepare-credentials
	npm run start --workspace=apps/api

.PHONY: dev-web
dev-web: ## Start Vite dev server on :5173
	npm run dev --workspace=apps/web

.PHONY: seed
seed: ## Seed admin credential + 500 pilots / 25 clubs / 50 club-teams + season fixtures
	node scripts/seed-admin.mjs --prepare-credentials
	node scripts/seed-fixtures.mjs
	node scripts/seed-admin.mjs

.PHONY: seed-rounds
seed-rounds: ## Seed 4 dev-browsing rounds (Proposed/Confirmed/BriefComplete/Locked)
	node scripts/seed-rounds.mjs

.PHONY: wipe-fixtures
wipe-fixtures: ## Surgical wipe of all fixture entities by manifest
	node scripts/wipe-fixtures.mjs

.PHONY: loadtest-prepare
loadtest-prepare: ## Create load-test round + 50 teams + confirm
	node scripts/prepare-loadtest.mjs

.PHONY: loadtest-register
loadtest-register: ## k6 register-self phase (500 VUs)
	@mkdir -p $(CURDIR)/logs/load-test
	@run_id=$$(date +%s); \
	log="$${REGISTER_LOG_PATH:-$(CURDIR)/logs/load-test/register-$$run_id.log}"; \
	cd tests/load && k6 run --env PHASE=register sign-to-fly.js >"$$log" 2>&1; \
	result=$$?; cat "$$log"; exit $$result

.PHONY: loadtest-captains
loadtest-captains: ## Assign captains and reconcile authoritative slot places
	node scripts/set-captains-loadtest.mjs

.PHONY: loadtest-transition
loadtest-transition: ## POST brief-complete on the prepared round
	node scripts/transition-loadtest.mjs

.PHONY: loadtest-sign
loadtest-sign: ## k6 sign phase
	@mkdir -p $(CURDIR)/logs/load-test
	@run_id=$$(date +%s); \
	events="$${SIGN_EVENTS_PATH:-$(CURDIR)/logs/load-test/sign-events-$$run_id.json}"; \
	summary="$${SIGN_SUMMARY_PATH:-$(CURDIR)/logs/load-test/sign-summary-$$run_id.json}"; \
	log="$(CURDIR)/logs/load-test/sign-$$run_id.log"; \
	cd tests/load && SIGN_EVENTS_PATH="$$events" SIGN_SUMMARY_PATH="$$summary" \
		k6 run --env SIGN_EVENTS_PATH="$$events" --env SIGN_SUMMARY_PATH="$$summary" \
		--out json="$$events" --summary-trend-stats="p(95),p(99)" sign-phase.js >"$$log" 2>&1; \
	result=$$?; cat "$$log"; \
	if [ $$result -eq 0 ]; then node ../../scripts/verify-loadtest-sign-artifacts.mjs "$$events" "$$summary"; \
	else exit $$result; fi

.PHONY: loadtest-verify
loadtest-verify: ## Verify signatures persisted and signToFly reflected
	node scripts/verify-loadtest-signtofly.mjs

.PHONY: loadtest-cleanup
loadtest-cleanup: ## Delete load-test round + signatures, keep fixtures
	node scripts/cleanup-loadtest.mjs

.PHONY: loadtest
loadtest: ## Run sequential load pipeline with verified cleanup policy
	node scripts/run-loadtest.mjs

.PHONY: clean
clean: ## Remove all dist/ directories and tsbuildinfo files
	rm -rf apps/api/dist apps/web/dist packages/types/dist packages/schemas/dist packages/scoring/dist
	rm -f packages/types/tsconfig.tsbuildinfo packages/schemas/tsconfig.tsbuildinfo packages/scoring/tsconfig.tsbuildinfo packages/schemas/dist/*.tsbuildinfo
