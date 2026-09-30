# Contract: make targets

The gate contract. A target's definition is normative — changing what a target does is a change to
this document. Every target must be runnable locally with identical behaviour to CI (R-09); a gate
that only exists in CI is a gate developers route around.

## Entry points

| Target | Must do |
|--------|---------|
| `make bootstrap` | install dependencies, start local infrastructure, migrate, seed — one command from a fresh checkout |
| `make ci` | the full gate set, in the order below, failing at the first failure |
| `make eval` | benchmark against the golden dataset (011) — release gate, not part of `ci` |

## `make ci` composition

```text
secret-scan       no secret material and no committed environment file (FR-008, FR-042)
deps-check        no unapproved dependency; licences permissive; lockfile in sync; a new runtime
                  dependency has an ADR in the same change set (FR-006)
db-check          prisma generate · schema drift vs migrations · migrations applicable to a clean DB
                  **and to the previous release's schema** · every migration's reverse exercised
                  (FR-010)
format-check
lint              includes boundary patterns (R-01) and the never-wait rule (R-02)
typecheck
build
test-unit         coverage floors enforced per path (R-11)
gate-coverage-completeness   every file under a risk-weighted, 95%-floor path is exercised by
                  some test at all — `coverage.all: false` reports only imported files, so an
                  unimported file is invisible to the threshold check above rather than merely
                  low-scoring (R-11)
test-e2e          disposable Postgres and Redis (R-12)
contracts-check   generated OpenAPI and clients match committed artifacts
gate-data-model   a change set altering the schema also updates the owning spec's data model (FR-015)
gate-isolation    every endpoint has a tenant-isolation test
gate-undo         every declared reversible action has a passing undo test
gate-ceiling      no autonomy grant exceeds ACTION_CEILING for its class, and none of class
                  reversible_remediation exists for an unattested undo (002 SC-004, C-18);
                  and no diff raising a ceiling level lands without a resolvable
                  threshold derivation artifact (002 FR-008a, 011 FR-021c)
gate-evidence     no conclusion type can be persisted without an evidence reference
gate-architecture-agnostic   no domain or agent package names a concrete architecture style,
                  runtime or vendor; those names appear only under integrations and adapters
gate-graph-confirm-capability   no MCP tool, worker job or API route exposes a graph
                  confirmation path; no agent or runner package references the graph:confirm
                  capability at all; a command or architecture infrastructure handler that does
                  expose one references the capability constant (004 FR-010, R-09)
gate-no-send      no package imports an outbound mail, SMS, chat or HTTP-client module except
                  the named egress allowlist, which contains no support package (009)
gate-agent-scope  an agent-authored change set touches no protected path and no pre-existing test
                  assertion (FR-054, FR-055)
gate-red-first    an agent-authored behavioural change set has a test that fails on the base
                  revision (FR-056)
```

`secret-scan` runs **first**: every later target reads the working tree, and a scan that runs after a
build has already had the chance to bake the secret into an artifact.

## Focused targets

Each is callable alone for iteration and is also called by `ci`:

`secret-scan` · `deps-check` · `db-check` · `format-check` · `lint` · `typecheck` · `build` ·
`test-unit` · `gate-coverage-completeness` · `test-e2e` · `contracts-check` · `gate-data-model` ·
`gate-isolation` · `gate-undo` · `gate-ceiling` · `gate-evidence` · `gate-graph-confirm-capability` ·
`gate-agent-scope` · `gate-red-first`

## Gate semantics

**Every gate fails closed** (R-10). Where a gate cannot determine the answer — the change set is not
inspectable, the base commit is missing, the schema cannot be introspected — it fails. A gate that
passes when confused produces a false record of compliance, which is worse than no gate.

| Gate | Fails when |
|------|-----------|
| `secret-scan` | the change set or the tree contains secret material, or a committed environment file (FR-008, FR-042) |
| `gate-data-model` | a change set alters the database schema without updating the owning specification's data model (FR-015) |
| `gate-isolation` | an HTTP route or MCP tool exists with no test asserting another tenant receives not-found |
| `gate-coverage-completeness` | a file under `packages/domain/policy`, `packages/domain/evidence`, `packages/shared/src/tenancy` or `packages/agents/src/output` has real logic (more than an `export {}` entry surface) and no test imports it at all (R-11) |
| `gate-undo` | an entry in the reversible action catalogue (010) has no passing undo test (satisfies 002 SC-005) |
| `gate-ceiling` | an `autonomy_grant` exceeds `ACTION_CEILING` for its class, or a `reversible_remediation` grant exists for an action whose undo is unattested (002 SC-004, C-18) — **or** the diff raises a ceiling level and cites no resolvable `threshold_derivation` artifact. The first two are checks on data against the ceiling function; the third is a check on an edit **to** the function, which no data check can see, and it resolves a committed artifact rather than the control-plane database, so the gate needs no credentials and cannot fail on a database outage (002 FR-008a, 011 FR-021c) |
| `gate-evidence` | a persisted conclusion type lacks a non-nullable evidence reference — the rule is **001 FR-009**; this feature owns only its enforcement (FR-016a) |
| `gate-architecture-agnostic` | a domain or agent package references a concrete architecture style, runtime or vendor by name — the rule is **constitution VII** (004 SC-008, FR-016a) |
| `gate-graph-confirm-capability` | an MCP tool, worker job or API route contains anything shaped like a graph confirmation/rejection path; an agent (`packages/agents`) or runner (`apps/runner`) package references the `graph:confirm` capability at all; or a command (`**/application/commands/**`) or architecture infrastructure handler exposes a confirm-shaped path without referencing the capability constant. A structural drift detector, not the real boundary — the rule is **004 FR-010, R-09** |
| `gate-no-send` | any package outside the egress allowlist imports an outbound mail, SMS, chat or HTTP-client module. Scoped **monorepo-wide, not to the support packages** — 009's adapters live under `integrations/` by design, so a support-send adapter added there would otherwise trip nothing (009 SC-005) |
| `lint` (never-wait) | a processor contains a sleep, a poll loop, or awaits external completion (R-02) |
| `lint` (boundaries) | a cross-module infrastructure import, a provider SDK outside its adapter, `@prisma/client` or `process.env` outside their permitted paths (R-01) |
| `lint` (suppression) | a boundary rule is suppressed inline; an exception exists only as a recorded entry referencing an ADR and naming an owner (FR-005) |
| `db-check` | a migration adds a tenant-scoped table without `tenant_id`; fails to apply to a clean database or to the previous release's schema; its reverse fails or is absent without a recorded irreversibility approval (FR-010, FR-049) |

| `gate-agent-scope` | the change set is agent-authored — by the CI-reported identity, or undeterminable (FR-054) — and modifies a protected path below, or edits or deletes an assertion in a test present on the base revision (FR-055), or its pull request names no task identifier present in the base revision's `tasks.md` (FR-053) |
| `gate-red-first` | the change set is agent-authored, its task carries no no-behaviour marker, and none of its added or modified tests fails against the base revision's production code (FR-056) |

### Protected paths

The single authority for FR-055. Agent-authored change sets may not modify:

```text
.specify/**                   constitution and spec-kit templates
specs/**/spec.md              specifications
docs/adr/**  docs/decisions.md
AGENTS.md  CLAUDE.md  .claude/rules/**
Makefile  scripts/**          gate implementations — secret-scan, db-check, the shared harness
                               and every gate-* script alike; narrowing this to `scripts/gate*`
                               would leave secret-scan.mjs, db-check.mjs and the harness an agent
                               can weaken unprotected
eslint.config.mjs  tsconfig*.json  vitest.config.ts   lint, boundary, coverage floors
.github/**  .gitlab/**  .gitlab-ci.yml   CI definitions and templates
test/*.ts                     shared test helpers — an assertion weakened inside a helper is invisible to R-15
.claude/skills/**             spec-kit commands
this file
```

## Runner targets

| Target | Must do |
|--------|---------|
| `make runner-build` | build the image; stamp protocol version and image version |
| `make runner-contract-test` | assert the evidence schema is closed — a free-form string field fails (R-04) |
| `make runner-compat-test` | run the capability handshake across the supported version window and one version below the floor, asserting refusal (R-03) |
| `make runner-diagnostics` | signal a running runner process (`SIGUSR2`, by PID or pidfile — no registry or query endpoint exists to find one another way) and print the support diagnostic bundle it dumps to a local file in response: versions, capability set, configuration reduced to presence-only, queue depths, timing histograms, the runner's own error signatures, and the last N exchanges as schema identifier and size — no customer data, no source, no log bodies (R-06, FR-024). Fails clearly, does not hang or fabricate output, when no runner process is found. Only reaches a runner in the caller's own PID namespace — a bare process or a container run with `--pid=host` — not one deployed normally via Compose (a separate PID namespace); reaching that case is `docker exec <container> kill -USR2 1` plus reading the dump back via `docker exec <container> cat <path>` or a mounted volume, not this command |

## Not in `ci`

`make eval` is a release gate rather than a per-commit one: it costs model spend and needs the
golden dataset. It runs on release candidates and on any change to prompts, agents or policy.
