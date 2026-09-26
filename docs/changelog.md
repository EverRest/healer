# Changelog

## 0.1.0 — 2026-09-23

Specification stage. No code.

- Constitution 1.0.0 — 8 principles; Evidence First, Anti-Circular Verification and Deterministic
  Control are non-negotiable.
- 23 decisions recorded in [decisions.md](decisions.md), with rejected options and their reasons.
- ADRs 0001–0007.
- Research wiki seeded: product thesis, incident taxonomy, failure modes, knowledge model,
  trust and adoption, security posture, market.
- Stage 0 defined; S0-1 (incident history audit) blocks realistic sizing of v1.

## 0.2.0 — 2026-09-24

Specification stage complete. Still no code.

- All 12 features specified, clarified, planned and broken into tasks: 340 functional requirements,
  133 success criteria, 1 094 tasks across 121 phases, 219 research entries, 27 contract documents.
- Seven clarifications resolved (C-01..C-07); four dissolved by reframing rather than by choosing a
  value.
- ADR 0008 added: capability passing for irreversible operations.
- Roughly thirty gaps found while writing tasks — where a spec or plan had left something
  unspecified — resolved rather than deferred, except the numeric values, which are now tracked
  explicitly in [stage-0.md](stage-0.md) S0-7.
- Notable correction: `ChangeVerifiedInProduction` is **not** emitted in v1. At L2 Healer neither
  merges nor deploys, so it never observes its own change in production. `IssueResolved` in v1 comes
  only from a verified reversible remediation or from a human.

## 0.3.0 — 2026-09-24

Specification stage complete and analyzed. Still no code.

- `/speckit-analyze` across all twelve specs: ≈110 findings, 10 CRITICAL, ~47 HIGH. Every spec was
  internally complete — FR→task 342/342, every success criterion and quickstart scenario covered,
  zero orphan tasks — and **all of the damage was at the seams between specs**.
- Twenty-one decisions recorded, C-08..C-28.
- Four recurring failure shapes, each fixed in every place it appeared: a guarantee that was prose
  rather than mechanism; a research decision that never reached the data model or tasks; a gate with
  no reader; an incentive problem wearing the clothes of a missing field.
- **Playwright and browser reproduction were missing from all twelve specs** while v1 targets a
  monorepo with a frontend. Resolved as two ladders selected by where the symptom is observable
  (C-24..C-28), which also fixed the reverse error — using a browser to reproduce a log-derived
  endpoint error.
- New cross-cutting docs: [patterns.md](patterns.md), [domain/glossary.md](domain/glossary.md),
  [workflows/investigation-pipeline.md](workflows/investigation-pipeline.md),
  [runbooks/runner-diagnosis.md](runbooks/runner-diagnosis.md).
- 1 151 tasks across twelve specs. Nothing open in the artefacts; stage 0 S0-1 still blocks sizing.

## 0.4.0 — 2026-09-24

Stage-0 review. Still no code.

- Walked the seven stage-0 items one at a time and recorded four decisions, C-29..C-32. Totals now
  **366 functional requirements, 138 success criteria, 1 166 tasks, 235 research entries, 587 quickstart
  scenarios**; FR coverage 366/366, 988 cross-spec requirement references, 112 task references and every
  internal link resolving.
- **The golden dataset is split** (C-29). Every entry declares `split ∈ dev · benchmark`, mandatory and
  never updated, on the entry rather than on dataset membership so an incident cannot be laundered into
  the sealed set by publishing a new version. Only a `benchmark`-scoped run may derive a threshold — a
  fifth check constraint alongside the four that already enforce C-05. The four thresholds that govern
  autonomy were being measured on the same incidents the prompts were tuned against.
- **The autonomy ceiling gained a gate on its own edit** (C-30). `gate-ceiling` validated grant rows
  against `ACTION_CEILING` and nothing looked at the function itself, so a pull request giving `merge` a
  level passed every gate in the repository — while the absence of that level is the whole of what holds
  v1 at L2. A raise now cites a `threshold_derivation` artifact the build can resolve without a database;
  the row stays the authority and the two are reconciled in both directions.
- **All six adapters stay in v1, with rollback landing in staging first** (C-31). The tempting cut —
  deploy and runtime, since at L2 Healer never deploys — does not survive the specs: 010's P1 story is
  rollback and 004's `DeploymentUnit` carries runtime identity.
- **Every unset value ships a starting value chosen to fail closed; four ship a clamp instead** (C-32):
  009's predicate 2 trust floor, 007's per-rung repeat counts, 002's escalation cap and budgets, 006's
  hypothesis threshold. Each is individually rational to lower and collectively they are the product's
  stop rules.
- S0-5 gained a real exit criterion: the share of a feature's historical incidents an adopted expectation
  would have covered, which is what predicts the `NO_EXPECTATION` rate and therefore how often 008's fix
  path fires at all. Adoption volume was never the criterion.
- [security-posture.md](security-posture.md) assembled for procurement out of ADR 0001, ADR 0006 and
  012's runner protocol — a consolidation, not new material, with the honest limit about source code
  reaching a model provider as its own named section rather than a line in the middle.
- Correction: the S0-7 table listed a *"masking rejection threshold"* for 008. No such threshold exists —
  masking detection is deterministic inspection and a hard refusal, and SC-009 is a fixture outcome.
- **Constitution 1.1.0**: three governance rules — a ceiling raise is gated on the build against a sealed
  measurement; every unset value ships a fail-closed starting value and, where it is a stop rule, a bound
  configuration cannot cross; a guarantee must name the mechanism that refuses to proceed without it.
- **ADR 0009**: derivation artifacts, and gating a diff rather than data.
- **[runbooks/raising-autonomy.md](runbooks/raising-autonomy.md)**: the procedure, and what each refusal
  means — written because the procedure was invented in this review and existed nowhere.
- Wiki: two failure modes added (measuring on the data you tuned on; a gate with no reader), trust-and-adoption
  gained "the rung is gated by a build, not by a conversation", the research security note now points at the
  customer-facing document rather than competing with it, and knowledge-model records that adoption volume
  was the wrong measure.
- Glossary: **stale entry fixed** — `Rung` still described one reproduction ladder after C-24 introduced two.
  Added `observableLocation`, `ThresholdDerivation`, `Derivation artifact`, `Clamp`, `Split`, `split_scope`,
  and a do-not-use row for "masking rejection threshold".

## 0.9.0 — 2026-09-26

Specification: 013 planned and broken into tasks; ADR 0010 carried into 008. No code.

- **013 regression-suite** through clarify, plan, tasks and analyze: research R-01..R-09, three tables
  in schema `regression`, a selection contract and OpenAPI document, 20 quickstart scenarios, 38 tasks
  with every requirement and success criterion covered.
- Corrected before it spread: 013's first draft said merging an expectation document is not adoption.
  005 R-16 and C-06 say approval of that pull request **is** adoption, and 013 now follows them — the
  "wiki of scenarios" is 005's repository markdown, reviewed like code.
- Cross-feature additions raised by 013: 005 R-08 front-matter keys (`subject`, `given`, `when`,
  `then`, `priority`); `test_binding_ref` crossing shape; `agent_kind = test_author`.
- 008 R-32 and tasks T127–T130: the change agent, applier, masking analyser and verifier run in the
  runner; the control plane keeps the state machine, guards and tables, which never held patch content.
- C-41 amended: self-hosted Grafana is the planned next step, triggered by an enterprise review or the
  bill, not a rejected option.
- The investigation pipeline page now covers thirteen features, the ADR 0010 seam and 013's seams.

## 0.8.0 — 2026-09-26

Specification: the regression suite (013) and five open questions closed. No code.

- **013 regression-suite** specified: 24 functional requirements, 7 success criteria. A regression
  scenario is an adopted `ExpectedBehavior` — no second store of expected behaviour. Healer drafts
  (API drafts from OpenAPI with no model call), a human adopts, a runner-side test author writes the
  test, a human merges, the customer's CI runs it on every pull request, on a schedule and after
  deploy, and a failure on the default branch becomes a `regression` issue in the one pipeline.
- C-36 no vector index over customer documents in v1 (closes S0-8) · C-37 Healer's repository on
  GitHub · C-38 provider keys rotated by hand through the customer's secret manager · C-39 the
  runner ships with Docker Compose · C-40 merge-rights ruleset read on a schedule for drift ·
  C-41 our own telemetry to Grafana Cloud through one collector, tenant identifiers hashed before export
  · C-42 a GitHub VCS adapter in v1, so Healer runs on its own repository. Constitution 1.2.1.
- ADR 0011: agent-driven development under the same gates. 012 R-13 and R-16 rewritten for GitHub;
  tasks T092–T095 added (ruleset drift, runner-side inference, `agent_run_report`, key rotation).
- Glossary: `ChangePlan` and control plane corrected for ADR 0010; `RegressionTestBinding` added.

## 0.7.0 — 2026-09-26

Specification: **inference follows the source** (ADR 0010, constitution 1.2.0). No code.

- Closed a contradiction at the boundary: the runner contract said file contents never cross, while
  ADR 0006 said source is in the change agent's prompt — and the change agent lived in the control
  plane. No specification described the path between the two.
- A model call now runs where its inputs live. The change agent, 008's masking inspection and the
  verifier execute in the runner against the tenant's provider; the control plane orchestrates through
  `agent_directive` and records `agent_run` from `agent_run_report`. The patch never crosses (C-33).
- A Healer-managed tenant's runner holds a per-tenant, spend-limited, revocable key; no shared key and
  no inference proxy (C-34). Runner-side inference is a declared capability; prompts cross towards the
  runner by identifier and digest (C-35).
- Runner protocol: four new runner-to-control-plane shapes (`change_plan_proposal`,
  `masking_candidate`, `verification_verdict`, `agent_run_report`), two new directives
  (`agent_directive`, `prompt_version`), `change_plan` no longer carries a patch. 008 FR-016a, 012
  FR-046a, 011 FR-004a amended; `agent_run` gains `executed_in` and `runner_instance_id`.
- Security posture: "Healer never processes your source code" is now true, and the runner needs one
  more outbound endpoint — the tenant's model provider.
- Open, stage-0 S0-8: knowledge embeddings in 005 are the same question for documents.

## 0.6.0 — 2026-09-26

Specification: agent-driven development (012 US10). No code.

- A coding agent takes one task to a pull request; only the gates and a human decide whether it lands.
  FR-053..FR-059, SC-020..SC-022, research R-13..R-16, quickstart 36–41, tasks T084–T091.
- **Who is an agent is the VCS host's bot flag**, never commit or pull-request text, and an
  unresolvable identity counts as an agent (R-13).
- Two new gates: `gate-agent-scope` — no protected path, no weakened pre-existing test assertion, a
  task identifier on the pull request — and `gate-red-first` — the change set's tests must fail on the
  base revision. The protected-path list has one authority, [make-targets.md](../specs/012-engineering-foundation/contracts/make-targets.md),
  and protects itself.
- Merge rights, budgets and parallelism are host and provider settings the agent's prompt cannot
  reach (R-16). Their ceiling — settings a local gate cannot read — is stated, not hidden.
- Totals: 373 functional requirements, 141 success criteria, 1 174 tasks.

## 0.5.0 — 2026-09-24

**First code.** 012 phases 1–2 implemented: setup and the foundations every other spec assumes.

- Monorepo: 27 workspace packages over pnpm workspaces with TypeScript project references, so a
  package importing past another's entry surface fails compilation rather than review.
- `packages/shared`: configuration validated once at start and frozen (the only reader of
  `process.env`); Pino logging with `tenantId` and `correlationId` bound and secret- and
  customer-content paths redacted; the closed error-code union; correlation through
  `AsyncLocalStorage`, stamped onto every OpenTelemetry span.
- **Tenancy is a compile-time guarantee**, not a convention: a repository accepts only
  `TenantScoped<W>`, whose brand is unexported, and the sole producer takes a `TenantContext`. An
  unscoped filter is a type error; a `@ts-expect-error` test holds that.
- `packages/events`: the transactional outbox — enqueue takes the transaction, not a store, so
  there is no overload that writes outside one.
- `packages/workflow`: the persisted state machine, the callback registry (tokens stored hashed,
  consumption idempotent, unmatched deliveries recorded), and the seven queue classes with their
  declared wall-clock budgets.
- **A state with nothing to wake it is now undeclarable.** The data model's invariant — a
  non-terminal run has a pending callback or a deadline — was to be checked periodically. A state is
  instead one of three shapes: terminal, awaiting a callback with a timeout, or job-owned with a
  declared wall-clock budget. The compiler proved the fourth shape unreachable while this was being
  written.
- Prisma multi-schema over five schemas with the initial migration **and its reverse**, plus an e2e
  test that applies both against a disposable Postgres and asserts the partial deadline index and the
  ADR 0004 extension list.
- `apps/api` health and readiness as the single source every version check reads; `apps/worker` as
  the same code in a separate process.
- Constitution 1.1.1: the seven queue classes named, as Governance requires of the pull request that
  introduces them.

Verified: `typecheck`, `lint`, `format-check` and 48 unit tests green. Not verified: the compose
stack and the migration were never applied — the Docker daemon was not running — so `test-e2e` has
not been executed. Recorded in 012's tasks.md rather than left implicit.

