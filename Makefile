# The single gate entry point (012 T019, T020, FR-007). Every target here must be runnable
# locally with identical behaviour to CI (R-09) — nothing exists only in a pipeline definition.
# Composition and order are normative in specs/012-engineering-foundation/contracts/make-targets.md;
# this is that document's implementation, not a second copy of its list.
#
# `ci`'s targets run as separate recursive `make` invocations rather than as prerequisites, so a
# failure aborts immediately regardless of `-j` — prerequisite order is not guaranteed under
# parallel make, but a single recipe's command lines always run in sequence.

.PHONY: help bootstrap graph-fixtures ci secret-scan deps-check db-check format-check lint typecheck build test-unit test-e2e \
	contracts-check gate-data-model gate-isolation gate-undo gate-ceiling gate-evidence gate-architecture-agnostic gate-graph-confirm-capability gate-no-send \
	gate-agent-scope gate-red-first gate-coverage-completeness runner-contract-test runner-compat-test runner-build runner-diagnostics runner-resolve-ref context-marker-corpus

# T072: every target above gets one `## description` comment on its own line, and this parses
# them — a target added without one is a target `make help` silently forgets, so the check is
# also what keeps this list itself honest instead of a second, driftable copy.
help: ## List every target with a one-line description
	@grep -E '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  %-28s %s\n", $$1, $$2}'

bootstrap: ## Install, start Postgres + Redis, migrate, seed — one command, no manual step (FR-050)
	pnpm install
	test -f .env || cp .env.example .env
	docker compose -f docker/docker-compose.yml up -d --wait
	pnpm exec prisma migrate deploy --schema prisma/schema.prisma
	pnpm run db-seed

graph-fixtures: ## Load the monolith, microservice and serverless architecture fixtures (004 SC-008)
	pnpm run graph-fixtures

ci: ## The full gate set, in contract order, failing at the first failure
	$(MAKE) secret-scan
	$(MAKE) deps-check
	$(MAKE) db-check
	$(MAKE) format-check
	$(MAKE) lint
	$(MAKE) typecheck
	$(MAKE) build
	$(MAKE) test-unit
	$(MAKE) gate-coverage-completeness
	$(MAKE) test-e2e
	$(MAKE) contracts-check
	$(MAKE) gate-data-model
	$(MAKE) gate-isolation
	$(MAKE) gate-undo
	$(MAKE) gate-ceiling
	$(MAKE) gate-evidence
	$(MAKE) gate-architecture-agnostic
	$(MAKE) gate-graph-confirm-capability
	$(MAKE) gate-no-send
	$(MAKE) gate-agent-scope
	$(MAKE) gate-red-first

secret-scan: ## No secret material and no committed environment file (FR-008, FR-042)
	pnpm run secret-scan

deps-check: ## Dependency allowlist, ADR 0004 Postgres extensions, licences, lockfile sync (FR-006)
	pnpm run deps-check

db-check: ## Schema drift, migration applicability and reverse, tenant_id + index rule (FR-009, FR-010)
	pnpm run db-check

format-check: ## Prettier, unmodified
	pnpm run format-check

lint: ## ESLint: boundary patterns, lint limits, never-wait-inside-a-job, no inline suppression
	pnpm run lint

typecheck: ## tsc --build across every project reference
	pnpm run typecheck

build: ## tsc --build, emitting dist/ for every package and app
	pnpm run build

test-unit: ## Vitest unit project, coverage-enforced (R-11)
	pnpm run test-unit

gate-coverage-completeness: ## Every risk-weighted, 95%-floor file is exercised by some test (R-11)
	pnpm run gate-coverage-completeness

test-e2e: ## Vitest e2e project against disposable Postgres and Redis (R-12) — needs Docker
	pnpm run test-e2e

contracts-check: ## Generated OpenAPI document matches the committed artifact (FR-009, FR-012)
	pnpm run contracts-check

gate-data-model: ## A schema.prisma change carries a specs/*/data-model.md update (FR-015)
	pnpm run gate-data-model

gate-isolation: ## Every HTTP endpoint has a tenant-isolation test (FR-013)
	pnpm run gate-isolation

gate-undo: ## Every reversible-action catalogue entry has a passing undo test (FR-014)
	pnpm run gate-undo

gate-ceiling: ## ceiling.ts and the autonomy_grant DB trigger agree on the ceiling per action class (002 SC-004, C-18)
	pnpm run gate-ceiling

gate-evidence: ## No persisted conclusion type has a nullable evidence reference (001 FR-009)
	pnpm run gate-evidence

gate-architecture-agnostic: ## No domain/agent package names a customer architecture style (004 SC-008)
	pnpm run gate-architecture-agnostic

gate-graph-confirm-capability: ## No MCP tool/job/route exposes graph confirm; no agent/runner carries the capability (004 FR-010)
	pnpm run gate-graph-confirm-capability

gate-no-send: ## No package outside the egress allowlist imports an outbound mail/SMS/chat module (009 SC-005)
	pnpm run gate-no-send

# Both are no-ops for a human-authored change set. Outside CI the author is presumed an agent
# (FR-054, R-13) until the developer says otherwise: HEALER_AUTHOR_IDENTITY=human. red-first reads
# the task from TASK_ID to honour an [NB] marker.
gate-agent-scope: ## An agent-authored change set touches no protected path and no existing test assertion (FR-055)
	pnpm run gate-agent-scope

gate-red-first: ## An agent-authored change set has a test that fails on the base revision (FR-056)
	pnpm run gate-red-first

# Runner targets (012 T049/T050, contracts/make-targets.md's "Runner targets" table). Not
# composed into `ci` above: the contract's own `ci` composition list omits them, and
# quickstart.md's gate verification section runs them as their own step after `test-e2e`, not
# folded into the fast loop or the e2e run — `runner-build` needs Docker, same reason `test-e2e`
# already runs separately.

runner-contract-test: ## Evidence schema is closed — a free-form string field fails (R-04)
	pnpm run runner-contract-test

runner-compat-test: ## Capability handshake across the version window and below the floor refuses (R-03)
	pnpm run runner-compat-test

runner-build: ## Build apps/runner's image, tag healer-runner:<version>, refuse to rebuild in place (FR-017)
	pnpm run runner-build

runner-diagnostics: ## Signal a running runner (SIGUSR2) and print its support diagnostic bundle (FR-024)
	pnpm run runner-diagnostics

context-marker-corpus: ## Seeded PII/secret markers through a full collection — 0 may cross the boundary (003 SC-001)
	pnpm run context-marker-corpus

# `make runner-resolve-ref <uuid>` — the uuid is read as a second goal, so it needs a no-op target
# of its own; scoped to this goal so a mistyped target elsewhere still fails loudly.
ifeq ($(firstword $(MAKECMDGOALS)),runner-resolve-ref)
RESOLVE_REF_ARGS := $(wordlist 2,$(words $(MAKECMDGOALS)),$(MAKECMDGOALS))
$(eval $(RESOLVE_REF_ARGS):;@:)
endif

runner-resolve-ref: ## Resolve a withheld item's localRef against the runner's plane-local ledger, inside the customer's network (003 FR-009)
	pnpm run runner-resolve-ref $(or $(RESOLVE_REF_ARGS),$(REF))
