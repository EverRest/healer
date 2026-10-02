# Phase 0 Research: policy engine, autonomy levels and budgets

Each entry is a decision, why it was taken, and what was rejected. Nothing here is left open.

## R-01 · The rule *set* is versioned, not the rule

**Decision**: rules are rows belonging to a `policy_ruleset`, which is immutable and
content-addressed over its ordered rule bodies. Editing configuration publishes a new rule set
version; nothing is edited in place. A `policy_decision` records exactly one `ruleset_version`.

**Rationale**: a decision must resolve forever to the rules that produced it (FR-004, SC-003). If
rules carried individual versions, a decision would reference a *combination* that was never itself
an addressable object, and "which rules were in force at 03:14 on a Tuesday" would have to be
reconstructed from validity intervals — reconstruction being exactly the thing this product refuses
to do elsewhere (constitution I). This is the same guarantee `prompt_version` gives in 012 R-07, for
the same reason.

**Alternatives**: per-rule versioning with validity intervals (the in-force set is derived, and
derived history drifts under clock skew and backdated edits); mutable rules with an audit log of
changes (the log describes the change, not the state, and replay requires replaying every change).

## R-02 · A closed predicate vocabulary, not an expression language

**Decision**: a rule is a conjunction of predicates drawn from a fixed vocabulary, each a
`(field, operator, value)` triple over the `DecisionInput` record. Fields, operators and value
domains are enumerated in the schema. There is no expression parser, no embedded language, no
user-supplied code.

**Rationale**: FR-002 requires identical inputs to produce identical outcomes, and that has to be a
property of the representation rather than a claim about the implementation. A conjunction over a
finite vocabulary is total, terminating and inspectable: the set of things a rule *can* say is the
set of things the schema permits. It is also the only form in which a tenant's configuration can be
shown back to them as prose they can check.

**Alternatives**: OPA/Rego or CEL — a new runtime dependency requiring an ADR (constitution VIII),
and in both cases the artifact that produces `ALLOW` becomes a program supplied by a tenant;
JavaScript predicates in the repository (not tenant-configurable at all, so every customer policy
change becomes our release).

## R-03 · Model confidence has no field

**Decision**: `DecisionInput` is a closed record whose fields are: action key, action class, target
(tenant, component, environment, issue kind, target reference), issue state facts, evidence
completeness facts, reproduction outcome, impact classification (008 FR-003), reversibility facts
(010), autonomy grant level, budget state and evaluation instant. No confidence field exists, and
the record rejects unknown keys.

**Rationale**: FR-003 says confidence MUST NOT be an input. A validation rule that strips it is a
rule someone can forget; a record that has nowhere to put it cannot be passed it. The dangerous
state should not be representable — the same argument that gives
`tenant_provider_config.fallback_scope` exactly one value in 012 R-08, and the same instinct as
C-02: where a wrong configuration causes an unobservable failure, remove the configuration.

**Alternatives**: accepting the field and ignoring it (indistinguishable, from the outside, from
accepting it and using it — and SC-002 would be proving a negative about implementation rather than
about shape).

## R-04 · The outcome lattice, and why the empty set is `DENY`

**Decision**: outcomes are ordered `ALLOW < REQUIRE_APPROVAL < DENY`. Evaluation matches **every**
rule in the set — there is no first-match, no priority, no salience — and folds the matched outcomes
with `max`, seeded with `DENY`. Matching rules that disagree therefore produce the most restrictive
outcome (FR-006), and an empty match set produces the seed, which is `DENY` (FR-005).

**Rationale**: absence of a rule and conflict between rules stop being two mechanisms with two
chances to be wrong, and become one fold with one identity element. Order-independence follows from
`max` being commutative and associative, which makes FR-002 a property test rather than a test
matrix. Conflict is still surfaced to the tenant as a configuration warning (FR-006) — the fold
resolves it safely, but a rule set where two rules disagree is a rule set whose author is confused.

**Alternatives**: first-match-wins with explicit ordering (the decision then depends on insertion
order, so a reordered import changes outcomes silently); numeric priorities (equal priorities
reintroduce order-dependence, and the tenant must now reason about a precedence system as well as
about their rules).

## R-05 · The ceiling is a clamp in code, enforced twice

**Decision**: `ACTION_CEILING` is a function of the action class **and** of whether the undo is
attested — `f(actionClass, hasTestedUndo)` (C-18): `read_only` → L1, `code_change` → L2,
`repository_write` → L2, `reversible_remediation` → L5 **when `hasTestedUndo` holds and no level at
all when it does not**, and `merge`, `forward_deploy` and `irreversible` → no level, meaning no grant
can exist.

The conditional is a parameter of the function rather than a footnote to it, because
`reversible_remediation` is the only class with a live L5 — the one place being wrong executes an
unattended production action. Leaving the attestation to tenant rule authorship plus a build gate is
the "one mechanism away from silent failure" argument this entry already rejects for the ceiling
itself, so it is enforced in the clamp **and** as a grant-time check returning `UNDO_NOT_ATTESTED`.

`repository_write` sits at L2 because writing a branch and opening a pull request **is** what L2
means (D-12). It is distinct from `code_change` — which is the act of producing a patch — so that a
tenant can grant patch production without granting the push, which is the shape some organisations
will want before they trust the branch namespace. It is a
constant in `packages/domain/policy/domain/ceiling.ts`. It is enforced twice: a check constraint
rejects an `autonomy_grant` row whose level exceeds the ceiling for its action class, and evaluation
applies `min(grant_level, ceiling(action_class, has_tested_undo))` before the outcome is returned.

**Rationale**: FR-008 requires un-exceedable, not defaulted, and SC-004 requires that zero such
configurations can be created. One mechanism is always bypassable by the path that does not go
through it — a seed script, a migration, a support escalation writing a row by hand. The constraint
stops the row from existing; the clamp makes a row that exists anyway ineffective. Neither is
sufficient, and the second is what makes the guarantee survive the first being wrong.

Rollback is not a forward deploy. It is a catalogue action of class `reversible_remediation` (010
FR-001), so it is governed by FR-009 and FR-010 and not by the L2 code-change ceiling — which is
exactly what the constitution's Autonomy Levels section says and what D-14 buys.

**Alternatives**: a `max_autonomy_level` configuration row (a row is editable, which makes the
dangerous state representable, and the difference between "nobody set it" and "somebody set it
higher" is invisible in a snapshot); a runtime assertion only (the bad grant exists in the table and
is visible to the tenant as permission they do not have, which is its own support incident).

## R-06 · Reversibility is derived from 010's catalogue, never stored here

**Decision**: policy holds no reversibility column. The predicate `target.reversible` resolves
against the 010 catalogue entry for the action key and is true only when the entry declares all four
of precondition, action, verification and undo (FR-009, 010 FR-002) **and** the undo has passed an
automated test in the current release (010 FR-003). The `gate-undo` check of 012 FR-014 enumerates
the catalogue and fails the build when any action lacks one, which is what makes SC-005 a build
property rather than a runtime hope.

**Rationale**: two stores of the same fact disagree, and the direction of disagreement here is the
expensive one: a stale `reversible = true` in policy permits an autonomous action whose undo was
removed. Deriving costs a join; storing costs a class of silent permission.

**Alternatives**: a cached reversibility flag refreshed on catalogue publish (the cache is correct
until a release changes the catalogue and the refresh does not run).

## R-07 · How revocation reaches a workflow that is already running

**Decision**: two mechanisms, because there are two cases.

1. **No decision is carried across a wait.** Evaluation happens inside the same job that performs
   the action, immediately before performing it (mirroring 010 FR-004 for preconditions). A
   `policy_decision` is bound to one `workflow_run`, one state and one proposal digest, and is
   consumed by that execution. A revoked grant therefore takes effect at the next guarded step with
   no push mechanism at all: the step re-evaluates, finds no grant, and the fold returns `DENY`.
2. **An approval is the one decision that legitimately spans a wait.** It records the tenant's
   `autonomy_epoch` at issue time. Revocation bumps the epoch in one write, which invalidates every
   outstanding approval for that tenant at redemption. It also enqueues a sweep that resolves open
   approval requests in scope to `revoked` and delivers the `approval` callback on 012's
   `workflow_callback` (012 FR-029, 012 FR-030), so a workflow parked awaiting approval moves to
   `needs_human` immediately rather than at its expiry.

**Rationale**: FR-007 requires immediate effect on in-flight workflows, and 012's design gives no
way to reach into a running workflow except through a callback. The epoch is what makes the
guarantee *correct* — it holds even if the sweep never runs, because redemption re-checks — and the
sweep is what makes it *prompt*. Building only the sweep would make correctness depend on a
background job; building only the epoch would leave a run sitting on a dead approval until its
deadline, which looks to a human exactly like an approval nobody has got to yet.

The epoch is per tenant rather than per grant scope, so one revocation invalidates every outstanding
approval for that tenant. Revocation is rare and the cost is a re-evaluation; narrowing the epoch to
the grant scope key is the upgrade path if that ever stops being true.

**Alternatives**: evaluating once at workflow start and carrying the decision (the entire failure
this requirement exists to prevent); scanning `workflow_run` rows on revocation and cancelling them
(the correctness of a safety property becomes the reliability of a batch job).

## R-08 · Dry run is a path, not a flag

**Decision**: `evaluate(ruleset, input)` is pure and returns `Decision` plus an `EvaluationTrace`.
Two callers use it. `EvaluateAndBind` (a command) persists the decision, binds it to a workflow run
and publishes `PolicyDecisionRecorded`. `ExplainDecision` (a query) returns the decision and the
trace and writes nothing — it does not require a proposal to exist, and it is reachable with a
read-only credential. The evaluator takes no `dryRun` parameter, because it has nothing to switch.

**Rationale**: FR-019 exists to serve 011, and 011 FR-004 requires the simulator's inability to
mutate to be **structural**, not a mode flag. A boolean on a mutating command is a capability that
is present and merely unset; a query handler that never constructs a repository write is a
capability that is absent. The second reason is subtler and matters more: a flag invites a branch,
and the first branch that differs makes the simulator measure something that is not the product.

The trace is the same object in both directions — matched rule identifiers, each rule's outcome, the
fold result, the ceiling clamp if it bound, the resolved grant, the budget verdict, and the rule set
version — so a simulator report and an audit entry describe a decision in the same terms (011
FR-003).

**Alternatives**: `evaluate(input, { dryRun: true })` (one branch away from a dry run that writes,
and one branch away from a dry run that is not the real path).

## R-09 · Approval expiry stops the workflow; it never permits

**Decision**: an `approval_request` carries `expires_at`, which is projected onto
`workflow_run.deadline_at` (012). The scheduled deadline tick resolves the request to `expired`,
records a `policy_decision` with outcome `DENY` and reason `APPROVAL_EXPIRED`, and transitions the
run to `needs_human`. There is no delegation, no escalation to a second approver and no default
approval.

**Rationale**: FR-016 and SC-007. The fold already guarantees that an unresolved approval cannot
produce `ALLOW`, because there is nothing to fold. What the expiry adds is *movement*: without it a
run sits indefinitely in a state indistinguishable from "an approver has not looked yet", and a
silent stall in a safety component is how people learn to route around it. Recording the lapse as an
explicit `DENY` rather than as absence keeps SC-001's reconciliation total — every guarded step has a
decision, including the ones that ended in nobody deciding.

**Alternatives**: implicit delegation to a fallback approver after a timeout (the spec's edge case
rules it out, and it converts an unavailable approver into an approval); leaving the request open
(indefinite silence).

## R-10 · Budget state is derived from 012's records, not counted here

**Decision**: spend is aggregated from `agent_run.cost` and time from `workflow_run` elapsed
duration (012 FR-033, 012 FR-036), filtered by tenant, scope and period key. This feature stores limits
(`budget_limit`, extending 012's `tenant_budget` to the per-issue scope) and nothing else. Budget
state is a query.

**Rationale**: 012 FR-036 names the agent run records as the single source consumed by budgets. A
counter maintained here is a second number, and the first time it disagrees with the billing figure
the question "which one is the budget" has no good answer. Aggregation is also idempotent by
construction — re-reading rows cannot double-charge, which is the failure a hand-maintained counter
has under BullMQ's at-least-once delivery.

No cache until the aggregate shows up in evaluation latency; the index is
`agent_run (tenant_id, started_at)` and the ceiling is roughly a tenant-month of runs per read.

**Alternatives**: a `budget_charge` ledger keyed on `agent_run_id` (correct, but it is a projection
of a table we already have, and it has to be reconciled against that table to be trusted).

## R-11 · Charge the declared ceiling before the step, reconcile after it

**Decision**: every AI step declares its maximum cost before running. The budget predicate tests
`consumed + declared_max ≤ limit`, not `consumed ≤ limit`. Actual cost lands in `agent_run` and the
next evaluation reads it.

**Rationale**: SC-006 requires spend to stay *within* the period budget under a flood, and a check
on consumption alone always permits one more step than the budget allows — the step that discovers
the limit is the step that exceeds it. Charging the declared ceiling ex ante bounds the overshoot at
zero without a reservation table or a two-phase commit.

**Corrected during implementation (T060):** the first draft of this paragraph also said "or a
lock", on the reasoning that the ex-ante check alone makes the tenant-period aggregate safe under
concurrency. It does not: under READ COMMITTED two concurrent steps both read `consumed = 90`, both
pass `90 + 10 <= 100`, and both commit. The charge has to be *visible to the next reader before it
runs*, and the read-then-write has to be serialised. So the declared maximum of an allowed step is
carried by its persisted `policy_decision` (`budget_state.reservedSpend`) — an *open charge*, derived
like everything else and replaced by the actual cost the moment a finished `agent_run` references the
decision — and resolve-and-persist run under a per-tenant advisory lock. Still no reservation table
and no counter; the cost of the design is that a decision whose step never runs stays charged until
something invalidates it (fail-closed, and recorded as an open item in QUESTIONS.md).

**Alternatives**: a reservation row released on completion (a distributed lease, with the leak that
every lease design has when a worker dies); checking consumption only (guaranteed to overshoot).

## R-12 · Degradation is derived state, marked once

**Decision**: `degradation_step` is `count of soft thresholds crossed by consumed / limit`, computed
from the same aggregate. It is monotone within a period because consumption is monotone. Each
*first* advance to a step writes one evidence record naming the step, the degradation entry applied
from the declared order (012 `tenant_budget.degradation_order`), the consumed and limit figures and
the period key; a `budget_degradation_mark` row on `(tenant, scope, period_key, step)` is the
idempotency key that keeps at-least-once job delivery from writing it twice.

**Rationale**: FR-012 requires the degradation to be an evidence record, which is the right call —
the diagnosis was produced under reduced context and the reader has to be able to see that, a year
later, without access to a metrics dashboard. Deriving the step from consumption means degradation
cannot disagree with the budget that caused it. The mark table exists only because `evidence` is
append-only with no natural uniqueness to lean on (001).

**Open coordination**: 001's `evidence.type` enum has no member that honestly carries this record.
`tool_output_summary` is a tool's output and this is not one. The decision here is to reference a
new member `budget_degradation` on the enum **owned by 001**, added there rather than redefined
here. This is recorded as a cross-spec item in the plan hand-off, not resolved unilaterally.

## R-13 · Cooldowns, rate limits and attempt caps live here, in Postgres, not Redis

**Decision**: FR-014's rate limits, cooldowns and attempt caps are predicates over `policy_decision`
history — the count of consumed `ALLOW` decisions for `(action_key, target_ref, fingerprint)` within
the window — evaluated in the same query that loads the rule set. The bounds themselves are
`policy.action_limit`; **no other feature stores or enforces them** (C-11), and 010 projects only the
refusal reason codes it shows a human. Redis stays where 012 put it: HTTP throttling and transient
state.

The scope is `(action_key, target_ref, fingerprint)` rather than the component, because "the same
remediation against the same target for the same recurring failure" is the thing that has to be
bounded; a component-wide count would refuse an unrelated action on a busy component.

**Rationale**: a refusal is a decision, and every decision has to be explicable a year later
(FR-017). A Redis counter is invisible in the audit trail, is lost on a flush or a failover, and
would make "why was this refused at 04:12" unanswerable — while the answer is sitting in a table we
are already writing for every decision anyway. The cost is one indexed count per evaluation.

**Alternatives**: Redis sliding-window counters (faster, unauditable, and the speed is for a path
that already does a database read).

## R-14 · Every mutating action has a registered key, and the reconciliation proves it

**Decision**: `policy_action` registers every action key with its class and whether it mutates. The
typed evaluation surface (D-06) is the only way to obtain an `ALLOW`, and the executor requires a
consumed decision identifier. SC-001 is a continuous reconciliation: executed mutating actions from
`audit_entry` (001 FR-012) left-joined to `policy_decision` — any row without a decision is an
alarm, not a test failure noticed at release time.

The join has a key because **`audit_entry.action` is a registered `policy_action.action_key`**, not
free text, and `policy_action.mutating` is what selects the rows that need a decision. That is a
constraint on 001's table, agreed there: over a free-text column the reconciliation could only guess
which entries were mutating actions, and a guess is not a check. The alternative — joining through
`agent_run.policy_decision_id` — was rejected because it sees only agent-executed actions and misses
every mutation performed by a runner, a human or the system, which is precisely the bypass this check
exists to find.

**Rationale**: FR-001 forbids a bypass path from existing, and "we checked that no caller skips it"
is a review claim that decays with every new caller. The reconciliation detects the bypass that the
review missed, and it detects it in production, where the bypass actually appears.

**Alternatives**: a lint rule requiring every mutating handler to call the evaluator (it can be
satisfied by calling and ignoring the result).

## R-15 · The ceiling is enforced against data; the edit to the ceiling needed its own gate

**Decision**: a change raising a ceiling level must cite a resolvable `threshold_derivation` artifact
(011 FR-021c), checked by 012's `gate-ceiling` on the diff. `ACTION_CEILING` remains a pure function of
`(action_class, has_tested_undo)` with no configuration input.

**Rationale**: `gate-ceiling` as originally specified validates `autonomy_grant` rows *against* the
ceiling function. It catches a grant that exceeds the ceiling, and it catches an unattested undo. It does
not look at the function, so a pull request giving `merge` a level of 3 passes every gate in the
repository — and in this release `merge` having no level is the whole of what keeps Healer at L2.

The four thresholds the constitution deliberately leaves unset are precisely the evidence that a raise is
earned. Until now nothing required them to be *read* at the moment they matter: 011 makes a derivation
impossible to fabricate, and then no consumer demanded one. That is the same failure shape the analyze
pass found twice elsewhere — a gate with no reader — sitting on the product's central promise.

**Why the citation governs the edit rather than the evaluation**: making the ceiling read a threshold at
runtime would put a database value on the permission path, and a value that can be read can be
misconfigured, cached stale, or fail open during an outage. The ceiling's strength is that it is a literal
in code. So the check belongs where the literal changes — in the build, on the diff — not in the
evaluator.

**Alternatives**: requiring a constitution amendment for a raise (already true, and it is a human process
with no mechanism — the same review that would approve the diff); a second approval in the dashboard
(protects the data path, which was never the hole).

## Unresolved

None.
