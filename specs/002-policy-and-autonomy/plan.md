# Implementation Plan: Policy engine, autonomy levels and budgets

**Branch**: `002-policy-and-autonomy` · **Spec**: [spec.md](spec.md) · **Date**: 2026-09-24

## Summary

A pure function from a closed input record to one of `ALLOW` · `REQUIRE_APPROVAL` · `DENY`, over an
immutable versioned rule set, with no model in the path and no way to reach a mutation around it.

Three commitments shape the design. **Determinism comes from the shape of the data, not from
discipline**: matching rules are folded over a restrictiveness lattice whose seed is `DENY`, so
absence of a rule and conflict between rules are the same mechanism, and evaluation is independent
of rule order. **The dangerous state is not representable**: model confidence has no field in the
input record, and the product autonomy ceiling is a code-level clamp applied after every grant, so
no configuration — and no direct database write — can produce an allowed action above it. And
**dry-run is the same code path**, not a flag: the evaluator is side-effect free and both callers
use it, because a flag is one missed branch away from letting the simulator (011 FR-003) measure
something that is not the product.

Budgets add nothing to the ledger. Spend and time are aggregated from `agent_run` and `workflow_run`
(012 FR-036), so the number policy enforces and the number support reports cannot disagree.

## Technical Context

**Language/Version**: TypeScript 5.x, Node 22 LTS

**Primary Dependencies**: NestJS 11 (`@nestjs/cqrs`), Prisma 6, Zod (the decision-input and rule
schemas), Pino, OpenTelemetry. No rule engine, no policy language — see R-02

**Storage**: PostgreSQL — `policy` schema. Rule sets and decisions are append-only; budget state is
derived by query, not stored (R-12)

**Testing**: Vitest, with a property test asserting order-independence of the fold; Supertest e2e
against disposable Postgres (012 R-12). Coverage floor 95% for this package (012 R-11)

**Target Platform**: control plane (ADR 0001). Policy never runs in the execution plane — a
decision made inside the customer's network would be a decision we cannot audit

**Project Type**: domain package `packages/domain/policy`

**Performance Goals**: evaluation under 20 ms p95 excluding the budget aggregate; the budget
aggregate under 50 ms p95 at 10 000 agent runs per tenant-month; a revocation is visible to every
in-flight workflow within one guarded step

**Constraints**: no model call, no network call and no clock read inside the evaluator — evaluation
time is an input, so a decision replays identically a year later

**Scale/Scope**: tens of tenants, low hundreds of rules per tenant, a decision for every mutating
action in the product

## Constitution Check

*GATE: must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | How this feature satisfies it | Status |
|-----------|-------------------------------|--------|
| I. Evidence First | Every decision records its inputs, rule set version and matched rules; each budget degradation is written as an evidence record (FR-012) rather than a log line | ✅ |
| II. Anti-Circular Verification | Policy predicates read structural facts only. A model's own output about its own work — confidence above all — is not an input, so a gate cannot be satisfied by the thing it is gating | ✅ |
| III. Reproduce Before Modify | Enforced here as a predicate: a `code_change` proposal without a `FAIL` reproduction (007 FR-001) does not match an `ALLOW` rule | ✅ |
| IV. Deterministic Control | This feature *is* Principle IV: versioned rules, closed predicate vocabulary, order-independent fold, no model in the path (FR-002, FR-003) | ✅ |
| V. Dependency-Aware Change | Impact classification from 008 FR-003 is a first-class predicate input; risk enters policy as what the change touches, never as file count | ✅ |
| VI. Serialize / Parallelize | Approval is a persisted state plus the `approval` callback of 012, never a wait inside a job (ADR 0003); expiry rides `workflow_run.deadline_at` | ✅ |
| VII. Architecture Agnostic | Grants scope to `Component` (004), never to a service name; the evaluator knows no architecture style | ✅ |
| VIII. Simplicity | No policy language and no rule engine; a fold over a four-element lattice, and budget state as a query rather than a counter | ✅ |

**Tenancy**: `tenant_id` on every table and in every query (012 FR-048). A cross-tenant read of a
rule set, grant, decision or approval returns not-found (FR-018, SC-008).

**Autonomy**: the product ceiling of FR-008 is a constant in code, applied as the last step of every
evaluation and again as a check constraint on the grant table (R-05). Raising it is a constitution
amendment and a release, not a configuration change.

## Project Structure

### Documentation (this feature)

```text
specs/002-policy-and-autonomy/
├── plan.md · research.md · data-model.md · quickstart.md
└── contracts/
    ├── openapi.yaml       # configuration, dry-run, approvals, budget reads
    └── evaluation.md      # the in-process evaluation contract and published events
```

### Source code

```text
packages/domain/policy/
├── domain/
│   ├── decision-input.ts     # the closed input record — no confidence field exists (R-03)
│   ├── outcome-lattice.ts    # DENY > REQUIRE_APPROVAL > ALLOW; fold seeded with DENY (R-04)
│   ├── predicates/           # the closed predicate vocabulary (R-02)
│   ├── ceiling.ts            # product autonomy ceiling per action class — a constant (R-05)
│   └── evaluate.ts           # pure: (ruleset, input) → Decision + EvaluationTrace
├── application/
│   ├── commands/             # PublishRuleset, GrantAutonomy, RevokeAutonomy, EvaluateAndBind,
│   │                         # RequestApproval, ResolveApproval, ExpireApproval, MarkDegradation
│   └── queries/              # ExplainDecision (dry run), GetDecision, ListApprovals, GetBudgetState
├── infrastructure/           # Prisma repositories, budget aggregation over 012 tables, outbox
└── presentation/             # controllers, DTOs
```

**Structure decision**: `evaluate.ts` is a pure function in `domain/` with no repository, clock or
logger in scope. Everything that varies — the rule set, the budget aggregate, the grant, the
evaluation instant — is passed in. That is what makes FR-002 testable rather than merely asserted,
and it is why dry run needs no separate implementation (R-08).

The reversible-action catalogue stays in 010. This package holds the action *registry* — the map
from action key to action class — because the ceiling clamps on class, and it derives
`reversible` from 010's catalogue rather than storing a second copy (R-06).

## Phase 0 — research

See [research.md](research.md): rule representation and why the rule set rather than the rule is
versioned, the predicate vocabulary, the outcome lattice and its `DENY` seed, the un-exceedable
ceiling, how revocation reaches a running workflow, approval expiry that stops rather than permits,
dry run as a path, budget derivation and the ex-ante charge, degradation as derived state, and why
cooldowns live in Postgres rather than Redis.

## Phase 1 — design

- [data-model.md](data-model.md) — `policy_ruleset`, `policy_rule`, `policy_action`,
  `autonomy_grant`, `autonomy_epoch`, `policy_decision`, `approval_request`,
  `budget_limit`, `action_limit`, `budget_degradation_mark`.
- [contracts/openapi.yaml](contracts/openapi.yaml) — configuration, dry-run evaluation, approvals,
  budget reads.
- [contracts/evaluation.md](contracts/evaluation.md) — the typed in-process surface every mutating
  feature calls (D-06), the closed input record, and the events published through the outbox.
- [quickstart.md](quickstart.md) — scenarios, including the ones that must be refused.

## Complexity Tracking

| Deviation | Why | Simpler alternative rejected because |
|-----------|-----|--------------------------------------|
| Rule sets versioned as immutable content-addressed sets rather than editable rows | A decision must resolve to the exact rules that produced it forever (FR-004, SC-003), the same guarantee `prompt_version` gives in 012 | Editable rules make a year-old decision unreproducible, and "which rules were in force" becomes a story rather than a record |
| A closed predicate vocabulary instead of an expression language | Determinism and reviewability. A tenant-authored expression is code we execute on behalf of a tenant, and `ALLOW` is the output | OPA/Rego or CEL is a new dependency needing an ADR (VIII), and makes "identical inputs → identical outcome" an argument instead of a type |
| The autonomy ceiling duplicated as a code constant *and* a database check constraint | FR-008 requires un-exceedable, not defaulted. The constraint stops the row being written; the clamp stops a row that was written anyway from having effect | A single mechanism is one migration, one support escalation or one seed script away from being bypassed, and the failure is silent |
| A grant epoch per tenant, invalidating every outstanding approval on revocation | An approval is the one decision that legitimately spans a wait, so it is the one place revocation cannot be handled by re-evaluation (R-07) | Scanning in-flight workflows on revocation makes the correctness of the guarantee depend on a background job completing |
| Budget state derived by query rather than stored as counters | 012 FR-036 makes the agent run records the single source; a counter is a second number that will eventually disagree with it | A materialised counter buys latency we have not measured a need for, and pays with a reconciliation class of bug in the component where being wrong permits an action |
