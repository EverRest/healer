<!--
Sync Impact Report
- Version change: 1.2.0 → 1.2.1 (PATCH: GitHub added to the v1 VCS adapter set for Healer's own
  repository — C-42; no principle changed)
- Version change: 1.1.1 → 1.2.0 (MINOR: inference follows the source — a model call over content that
  may not cross the boundary executes in the execution plane; the control plane orchestrates. ADR 0010,
  C-33..C-35. Impact: 012 FR-033/FR-045/FR-046a and data model, 008 FR-016a, runner protocol,
  security posture, ADR 0001, ADR 0006; open item stage-0 S0-8 for 005)
- Version change: 1.1.0 → 1.1.1 (PATCH: the seven queue classes named, as Governance requires of the
  pull request that introduces them — 012 phases 1–2)
- Version change: 1.0.0 → 1.1.0 (MINOR: three governance rules added — a ceiling raise is gated on the
  build against a sealed measurement; unset values ship fail-closed starting values and, where they are stop
  rules, bounds configuration cannot cross; a guarantee must name its reader)
- Version change: 0.0.0 → 1.0.0 (MAJOR: initial ratification)
- Principles defined: I. Evidence First (NON-NEGOTIABLE); II. Anti-Circular Verification (NON-NEGOTIABLE);
  III. Reproduce Before Modify; IV. Deterministic Control; V. Dependency-Aware Change;
  VI. Serialize Mutations, Parallelize Observation; VII. Architecture Agnostic; VIII. Simplicity
- Sections: Source Trust Hierarchy; Technology & Boundaries; Autonomy Levels; Security Model;
  Development Workflow; Governance
- Templates requiring updates: none yet (no specs written)
- Deferred: false-fix threshold and per-incident cost ceiling — set from benchmark data (stage 0)
- 1.1.0 impact: 002 (FR-008a, SC-009, R-15), 011 (FR-011a, FR-021b, FR-021c, R-19, R-20), 012
  (`gate-ceiling`), 006 FR-028, 007 FR-031, 009 FR-026, ADR 0009, stage-0 S0-2/S0-3/S0-7 — all already
  written; this amendment records the rule the specs now enforce rather than introducing a new one
-->

# Healer Constitution

Healer is a hybrid-deployed product that turns an issue — a production incident, a user report,
an alert or a regression — into a diagnosis backed by evidence, and where permitted into a
verified change, without ever taking an action the evidence does not justify.

The centre of this architecture is **not the LLM**. The centre is **Evidence + Domain State +
Policy + Verification**. The model proposes; evidence, policy and verification decide.

## Core Principles

### I. Evidence First (NON-NEGOTIABLE)

- Every claim the system makes MUST be traceable to an evidence record. No assertion of root
  cause, impact or resolution without evidence supporting it.
- `Evidence` is immutable, append-only, typed, timestamped, and carries its source and provenance.
- **Evidence links are emitted by the step that produced them.** No step may author an evidence
  link about a step other than itself. Explanations reconstructed after the fact by a model are
  post-hoc rationalisation and are forbidden — they manufacture trust rather than record it.
- Timeline, postmortem, audit trail, evidence graph and change correlation are **five views of
  one dataset**, never five subsystems.
- `Evidence` is not `Knowledge`. Evidence is observed, incident-scoped and immutable; knowledge is
  authored, durable and rots. Knowledge contributes to evidence, cited and with lower trust.

Rationale: the failure mode of this product is a confident wrong answer. Evidence is the only
thing that makes a wrong answer visible.

### II. Anti-Circular Verification (NON-NEGOTIABLE)

- **No verification step may anchor on an artifact produced by an earlier step in the same chain.**
  Verification anchors only on: adopted `ExpectedBehavior`, raw evidence, human-written tests, or
  production signal.
- A regression test is valid only when its assertion traces to an `ExpectedBehavior` that existed
  **before** the issue. A test that merely fails on the old code proves nothing — a wrong test also
  fails on the old code.
- The reviewing agent MUST be able to return `REJECT_DIAGNOSIS`, not only `REJECT_PATCH`.
- Two models are not two independent judges. Ranked by real independence:
  production signal > human-written tests > expectation-anchored regression test > second model >
  self-review. Gates are designed in that order of trust.
- An answer's citations MUST be independently checked to support its claims. Citing is not grounding.

Rationale: every gate can report PASS while the system is confidently wrong, if the gates verify
against the system's own earlier conclusions.

### III. Reproduce Before Modify

- No code change without a failing reproduction first. Diagnosis alone never authorises a patch.
- Reproduction result is `PASS | FAIL | INCONCLUSIVE`. **`INCONCLUSIVE` is a first-class outcome**,
  not a failure: it routes to a human with the accumulated evidence and rejected hypotheses.
- Before anything else, the system MUST classify whether the issue is a code problem at all.
  Patching code to compensate for an infrastructure, capacity, config or third-party failure is
  worse than doing nothing: the defensive code outlives the incident. The classifier runs **before
  hypothesis generation**, not after reproduction — otherwise sandbox time is spent on a Redis
  outage. It is owned by diagnosis (006), listed here because it guards the modify path.
- Repeated failure is output, not only cost. After the attempt limit, the handoff to a human
  carries what was ruled out and why.

### IV. Deterministic Control

- The Policy Engine is deterministic, versioned, and **cannot be overridden by model output**.
  Every mutation passes it. Every decision is audited.
- Model self-reported confidence is **never** a gate predicate. Gates use structural, checkable
  facts: does every claim map to a citation, is the category allowlisted, did the tests run, does
  an adopted expectation exist.
- Every mutating operation is idempotent; retries and duplicate events never double-apply.
- Every AI path has a cost budget and a stop rule: per issue, per tenant, per day. Degradation
  order is declared, not improvised.

### V. Dependency-Aware Change

- A change is scoped by its **impact graph**, never by file count. A one-line change to an auth
  check outranks a thirty-file rename.
- Impact Analysis is deterministic first (AST, type graph, call graph, contracts, migrations,
  tests, event consumers, feature flags) and only then interpreted by a model.
- Risk comes from what the change touches — public contract, database migration, auth, money path,
  cross-component boundary — not from its size.

### VI. Serialize Mutations, Parallelize Observation

- Evidence collection runs in parallel. State-changing operations run in sequence, each verified
  before the next begins.
- The workflow is an explicit state machine persisted in Postgres — it is also the audit trail and
  the artifact a customer's change-management process reviews.
- **Never wait inside a job.** Every long wait (CI, deploy, canary observation) is a persisted
  state plus an inbound callback. Jobs stay short and idempotent.

### VII. Architecture Agnostic

- The domain models `Component`, not `Service`. Monolith, microservices, SOA, serverless, frontend
  and legacy are different graphs, not different products.
- Logical `Component` and `DeploymentUnit` are separate. `Component` ↔ `Repository` is many-to-many.
- Architecture is described by `characteristics`, not by an enum. Real systems are hybrid.
- Agents receive `SystemContext` and know nothing about the customer's architecture style.
  Architecture-specific code lives only in adapters and discovery.
- The model is general from day one; the **shipped adapter set is one stack** until the loop is proven.

### VIII. Simplicity

- Start with the smallest thing that closes the loop. A capability that cannot be verified does
  not ship.
- New dependency or new pattern requires an ADR.
- Prefer deterministic tooling over a model wherever the answer is derivable. A timeline is a
  database join, not an AI feature.

## Source Trust Hierarchy

Sources contradict each other. The ranking **inverts by the question being asked**, and this is
what keeps a stale wiki from causing a misdiagnosis.

**"What does the system actually do?"**

```text
1. Observed reality      logs, traces, metrics, test runs     ← highest
2. Code and tests        what actually runs
3. Verified incidents    history carrying its own evidence
4. Human-written wiki    claims of unknown age                ← lowest
```

**"What should the system do?"**

```text
1. ExpectedBehavior      adopted, human-owned                 ← highest
2. Human-written acceptance tests
3. Code                  describes current, not correct
4. Observed reality      describes broken, not correct        ← lowest
```

The wiki is never authority on current behaviour, only on intended behaviour. Code-versus-wiki
disagreement is itself an issue of type `KnowledgeDrift`, routed to a human and never auto-resolved
in either direction.

**Provenance affects trust.** Every knowledge document records whether it is human-authored,
machine-generated, or machine-generated-and-human-adopted. Machine-generated content MUST NOT
become an `ExpectedBehavior`: if Healer can write its own verification anchors, Principle II is
void. Machine-proposed expectations require explicit human adoption.

## Technology & Boundaries

| Area | Decision |
|------|----------|
| Language | TypeScript |
| Backend | NestJS (`@nestjs/cqrs`), monorepo, API + worker processes |
| Storage | PostgreSQL — source of truth; graphs via recursive CTE; retrieval via pgvector |
| Queue | Redis + BullMQ. No Temporal — enforced by "never wait inside a job" (VI) |
| Sandbox | Container isolation, default-deny egress, no production credentials, ever |
| Code intelligence | TypeScript compiler API / ts-morph (v1 adapter) |
| LLM | Provider-agnostic interface; direct provider SDKs on the production path, OpenRouter in the eval harness only; provider config is per-tenant; a call over content that may not cross runs in the runner (ADR 0010) |
| Observability in | Grafana / Loki / Prometheus / OpenTelemetry (v1 adapter set) |
| VCS | GitLab (v1 adapter, matching the design partner); GitHub (v1 adapter for Healer's own repository, C-42) |
| MCP | Outward-facing surface only; internal agents use typed in-process interfaces |
| Tests | Fast unit tests in the Healer sandbox; full suite and e2e delegated to the customer's CI |
| Browser automation | Playwright, for the client reproduction ladder's top rung and for user-journey verification (007, 008). The most expensive operation in the product; it requires a declared reason and is never reached by omission |

**Queue classes.** One queue per workload class, because a flood of one must not delay another.
`ingestion` · `collection` · `reasoning` · `execution` · `remediation` · `scheduling` ·
`maintenance`. Each declares a concurrency limit and a **wall-clock budget**; exceeding the budget
fails the job and records a `timeout` transition rather than succeeding late (012 R-02). A new class
is added to this list in the pull request that introduces it.

**Deployment is hybrid.** The control plane (issues, evidence, policy, agent orchestration,
knowledge index, dashboard) is Healer's. The execution plane (repository checkout, sandbox, test
execution, code intelligence, log collection and redaction, remediation actions) runs in the
customer's infrastructure.

**Inference follows the source.** A model call runs where its inputs live: a call whose input
includes content that may not cross the boundary — source text, patch content — executes in the
runner against the tenant's provider, and returns only closed contract shapes. The control plane
orchestrates it, and never receives what it was not allowed to receive in the first place
(ADR 0010).

**What crosses the boundary is a contract.** The runner sends structured evidence — normalised
error signatures, trace shapes, metric deltas, file paths, test results. It does not send raw log
bodies. Redaction happens on the customer's side or hybrid deployment has bought nothing.

**Multi-tenant from day one.** `tenantId` is mandatory in every query and every retrieval,
enforced at the query layer, never by prompt and never by post-filtering.

## Autonomy Levels

```text
L0  detect
L1  diagnose
L2  fix + pull request          ← ceiling for year one
L3  merge
L4  deploy + verify
L5  autonomous remediation
```

- Autonomy is granted **per tenant, per component, per environment, per issue type, per action** —
  never globally.
- Raising a level requires: a benchmark threshold met, a production success threshold met, rollback
  capability, full audit coverage, and policy coverage for every action the level permits.
- **A change that raises the ceiling is refused by the build unless it cites the measurement.** The
  ceiling is a pure function of action class and undo attestation, with no configuration input, so a raise
  is an edit to source — and an edit is what must be gated. The citation resolves a derivation from a run
  that was complete, repeatable, real-only and **drawn from a sealed measurement set the system was not
  tuned against**. A threshold measured on the incidents the prompts were fitted to is optimistic by
  exactly the amount of fitting, and the consequence of optimism here is an agent writing to a customer's
  repository. Where the measurement does not exist, the level does not exist.
- **Reversible actions are governed separately from code changes.** Rollback, restart, feature-flag
  disable, scale and queue drain are permitted at higher autonomy than patching, because they are
  reversible by construction and verifiable in minutes. Each one requires a declared precondition,
  action, verification and undo.
- The L2 ceiling forbids **forward** deploys. Rollback to a previously deployed version is a
  reversible remediation, not a forward deploy, and is governed by the rule above.
- Customer-facing text is never sent by Healer. AutoSupport proposes; a human or an external system
  sends.

## Security Model

- **Permissions are what an agent's tools grant, not what its prompt says.** Capability-scoped
  credentials per agent: the diagnosis agent's token cannot write to a repository; the change
  agent's token cannot merge.
- **All retrieved content is data, never instructions.** Logs, tickets, wiki pages, PR descriptions
  and commit messages are attacker-influenced input reaching an agent that can write to a
  repository. Prompt injection through them is a supply-chain attack on the customer.
- The sandbox holds no production credentials and has default-deny network egress. A test suite
  with internet access can exfiltrate a source tree; that matters more than container escape.
- No agent gets raw shell access. Tools are declared, schema-validated, permission-checked and
  audited on every invocation.
- Every agent action carries an audit record: actor, action, reason, evidence, model, prompt
  version, tools used, files touched, tests run, policy decision, outcome.

## Development Workflow

```text
/speckit-specify → /speckit-clarify → /speckit-plan → /speckit-tasks → /speckit-analyze → /speckit-implement
```

- Specs are the contract. Code contradicting a spec is a bug or a spec update — never a silent
  decision.
- TDD: red → green → refactor for every behaviour. This is how the product works; it is also how
  the product is built.
- Every capability ships with observability, failure handling, audit trail, and its exit criteria
  met — not merely "the feature works".
- Every new endpoint gets a tenant-isolation test: another tenant's data returns 404.
- Documentation language is English. Identifiers, commits and specs are English.

## Governance

- This constitution supersedes other practices. Violations of I, II or IV block merge.
- Amendments require a version bump, a Sync Impact Report in this file, and migration notes where
  specs depend on the changed text.
- Semantic versioning: MAJOR for a removed or redefined principle, MINOR for a new principle or
  section, PATCH for clarification.
- New queue class or dependency is added to this document in the pull request that introduces it.
  Module boundaries are enforced by **patterns**, not by a name list (012), so a new module needs no
  lint edit — but the package set in 012 FR-001 is the documented list and is kept current there.
- Four thresholds are deliberately unset — **false-fix rate**, **30-day revert rate**,
  **per-incident cost ceiling** and **escalation attempt cap**. They are derived from the benchmark
  in stage 0, not chosen in a vacuum. Until they exist, L2 is the hard ceiling and every merge is
  human.
- **Every deliberately unset value ships a starting value chosen to fail closed**, and a value whose
  lowering removes a stop rule ships a bound configuration cannot cross — written as a literal with a
  matching constant in code, never as a symbol resolved at runtime. A value nobody set is not neutral: it
  is whatever the code does when the column is empty, decided by accident.
- **A guarantee names the mechanism that refuses to proceed without it.** A mechanism that is correct,
  unforgeable and on nobody's decision path is not a control. "A reviewer would notice" is not a reader.

**Version**: 1.2.1 | **Ratified**: 2026-09-23 | **Last Amended**: 2026-09-26
