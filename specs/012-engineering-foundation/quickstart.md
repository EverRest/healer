# Quickstart: engineering foundation

## From a clean checkout

```bash
make bootstrap      # install, start Postgres + Redis, migrate, seed
make ci             # the full gate set
```

Success criterion for this feature: a developer who has never seen the repository runs those two
commands and gets green, with no undocumented manual step (FR-050..052).

## Scenarios

Each scenario proves a gate **fails when it should**. A gate that has never been seen to fail is
not known to work.

| # | Scenario | Steps | Expectation |
|---|----------|-------|-------------|
| 1 | Bootstrap | fresh clone → `make bootstrap && make ci` | green, no manual steps, under the CI budget |
| 2 | Boundary lint | import another module's `infrastructure/` | `lint` fails naming both modules |
| 3 | New module is governed | add `packages/domain/newthing/` importing a foreign infrastructure path | `lint` fails **without editing any rule** (R-01) |
| 4 | Provider SDK escape | import an LLM SDK outside its adapter | `lint` fails |
| 5 | `process.env` escape | read `process.env` in a domain package | `lint` fails |
| 6 | Never-wait rule | add `await sleep(30_000)` inside a processor | `lint` fails (R-02) |
| 7 | Never-wait at runtime | processor exceeds its declared wall-clock budget | job fails, alert raised, no silent late success |
| 8 | Missing `tenant_id` | migration adds a tenant-scoped table without it | `db-check` fails |
| 9 | Schema drift | edit the Prisma schema without a migration | `db-check` fails |
| 10 | Isolation gate | add an endpoint with no isolation test | `gate-isolation` fails naming the route |
| 11 | Undo gate | add a reversible action with no undo test | `gate-undo` fails (002 SC-005) |
| 12 | Evidence gate | add a conclusion type with a nullable evidence reference | `gate-evidence` fails |
| 13 | Fail closed | run a gate where the base commit is unavailable | the gate **fails**, does not skip (R-10) |
| 14 | Contract drift | hand-edit generated OpenAPI | `contracts-check` fails |
| 15 | Prompt immutability | attempt to update a published `prompt_version` row | rejected; republishing identical content is a no-op; changed content creates a new version |
| 16 | Audit resolves | take an `agent_run` from a month ago | its `prompt_version_id` and model identifier both resolve |
| 17 | Runner handshake | connect a runner two minor versions old | `active` or `degraded`; read paths work, gaps recorded |
| 18 | Runner floor | connect a runner four minor versions old | `refused`, required upgrade reported (C-02) |
| 19 | Degrade vs refuse | runner lacks a read capability, then a write capability | read degrades with a recorded gap; write refuses with a reason |
| 20 | Evidence contract | attempt to transmit a free-form string field | schema rejects it (R-04) |
| 21 | Redaction withholding | evidence the redactor cannot clear | item withheld, `collection_gap` recorded — not truncated (R-05) |
| 22 | Blind diagnostics | produce a runner diagnostic bundle | contains no customer data, source or log bodies (R-06) |
| 23 | BYO fallback trap | BYO tenant, induce provider failure | work fails and retries; **no call to a Healer-provided provider** (R-08, FR-046) |
| 24 | Workflow resumption | kill the worker mid-run, restart | the run resumes from its persisted state; no work is lost or repeated |
| 25 | Callback idempotency | deliver the same callback twice | second delivery changes nothing but is counted |
| 26 | Stuck run detection | a run left with neither a pending callback nor a deadline | reported by the periodic check |
| 27 | Secret scan | commit a file containing a private key, and separately a `.env` | `secret-scan` fails both times, before `build` ever runs (FR-008, FR-042) |
| 28 | Migration against the previous release | a migration that applies to an empty database but not to the previous release's schema, and one whose reverse fails | `db-check` fails both times (FR-010) |
| 29 | Data model not updated | change the database schema without touching the owning spec's `data-model.md` | `gate-data-model` fails naming the specification (FR-015) |
| 30 | Inline suppression rejected | suppress a boundary rule inline instead of recording an exception | `lint` fails; only a recorded entry referencing an ADR and naming an owner is accepted (FR-005) |
| 31 | Dependency without an ADR | add a runtime dependency with no ADR in the change set | `deps-check` fails (FR-006) |
| 32 | Vector index rebuild | drop the pgvector index and rebuild it from Postgres | every previously retrievable item is retrievable again, 0 loss (FR-047, SC-019) |
| 33 | Prompt pinning | make a model return output that names a different prompt version | the run keeps its pinned prompt; selection is deterministic per agent (FR-041) |
| 34 | Operator access is audited | a Healer operator reads a tenant's traces and run records | the read is tenant-scoped and leaves its own audit entry (FR-037) |
| 36 | Agent scope | as a bot identity, change `specs/**/spec.md`, then `eslint.config.mjs`, then [contracts/make-targets.md](contracts/make-targets.md) | `gate-agent-scope` fails each time naming the path (FR-055) |
| 37 | Assertion weakening | as a bot identity, remove an `expect(` line from a test that exists on the base revision | `gate-agent-scope` fails; the same change by a human identity passes (FR-055, R-15) |
| 38 | Unknown author | run the gate where neither author nor pipeline user resolves | treated as agent-authored; a protected-path change fails (FR-054) |
| 39 | Red-first | as a bot, add a test that already passes on the base revision, then one that fails on it | first fails `gate-red-first`, second passes; a `[NB]` task added in the same change set does not exempt it (FR-056, R-14) |
| 40 | Agent pull request | an agent job completes a `[P]` task | pull request cites task and FR identifiers; `make ci` green on its head before review (FR-053) |
| 41 | No agent merge | with the agent's bot token, try to merge and to approve | host refuses both (FR-057, R-16) |
| 35 | Irreversible migration | add a destructive migration with no marking, then with a marking and no recorded approval | `db-check` fails both times (FR-049) |

## Gate verification

```bash
make secret-scan                 # first, always — before anything can bake a key into an artifact
make lint typecheck test-unit    # fast loop
make test-e2e                    # disposable Postgres + Redis
make runner-contract-test        # evidence schema is closed
make runner-compat-test          # handshake across the version window and below the floor
make runner-build                # build and tag the image, refuse a rebuild in place (FR-017)
```
