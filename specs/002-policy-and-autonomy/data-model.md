# Data Model: policy engine, autonomy levels and budgets

Schema `policy`. Identifiers are UUID v7; timestamps `timestamptz` UTC. Every **tenant-scoped** table
carries `tenant_id` with an index `(tenant_id, …)`
([prisma rules](../../.claude/rules/prisma-migrations.md)). Two tables are not tenant-scoped:
`policy_action` is global, because the set of actions the product can perform is a product fact, and
`policy_rule` carries no `tenant_id` of its own — it belongs to a `policy_ruleset`, which does, and a
rule is never read except through its rule set.

Tables owned elsewhere and only referenced here: `audit_entry`, `evidence`, `issue` (001);
`workflow_run`, `workflow_callback`, `agent_run`, `tenant`, `tenant_budget` (012); the remediation
action catalogue (010); `component` (004).

## policy.policy_ruleset (immutable)

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| version | int | monotone per tenant; a decision cites this |
| digest | text | content hash over the ordered rule bodies; unique `(tenant_id, digest)` |
| published_at | timestamptz | |
| published_by | text | human or system actor |
| supersedes_version | int? | the version this replaced |
| conflict_warnings | jsonb | rule pairs that can both match with different outcomes (FR-006) |

No update path. Republishing identical content is a no-op; changed content is a new version (R-01).
The publish writes an `audit_entry` naming both versions — because the rule sets are immutable and
addressable, that entry *is* the diff (FR-020).

## policy.policy_rule (immutable, belongs to a rule set)

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| ruleset_id | uuid | FK |
| rule_key | text | stable across versions, so a rule can be followed through history |
| predicates | jsonb | conjunction of `(field, operator, value)` from the closed vocabulary (R-02) |
| outcome | enum | `allow` · `require_approval` · `deny` |
| reason_code | enum | carried into the decision; never free text. Closed set: `NO_MATCHING_RULE` · `CEILING_EXCEEDED` · `NO_AUTONOMY_GRANT` · `GRANT_REVOKED` · `ENVIRONMENT_RESTRICTED` · `COMPONENT_RESTRICTED` · `ISSUE_KIND_RESTRICTED` · `IMPACT_CLASS_RESTRICTED` · `EVIDENCE_INCOMPLETE` · `NO_ADOPTED_EXPECTATION` · `UNDO_NOT_ATTESTED` · `BUDGET_EXHAUSTED` · `RATE_LIMITED` · `COOLDOWN` · `ATTEMPT_CAP_REACHED` · `ESCALATION_CAP_REACHED` · `APPROVAL_REQUIRED` · `APPROVAL_EXPIRED` · `TARGET_BLOCKED` · `CATEGORY_NOT_ALLOWLISTED` · `TOPIC_BLOCKED`. Adding one is a spec change, so a decision can never carry a reason nobody planned for |
| note | text | tenant-facing explanation, shown in the approval summary |

Unique `(ruleset_id, rule_key)`. `predicates` is schema-validated on publish: an unknown field, an
operator outside the field's domain, or a value of the wrong type rejects the whole rule set.

**There is no priority column.** Evaluation matches every rule and folds (R-04).

## policy.policy_action

The action registry. Reversibility is **not** here — it is derived from 010's catalogue (R-06).

`action_key` (PK, e.g. `change.open_pull_request`, `deployment.rollback`),
`action_class` (`read_only` · `code_change` · `repository_write` · `reversible_remediation` ·
`merge` · `forward_deploy` · `irreversible`), `mutating` bool, `owning_spec`, `introduced_at`.

Global, not tenant-scoped: the set of actions the product can perform is a product fact.

Action keys are the keys 010's catalogue publishes — `deployment.rollback`, not a paraphrase of it.
A contract test asserts that every entry in 010's catalogue exists here with
`action_class = reversible_remediation`, because a key that is spelled differently in two specs is a
registry lookup that fails at the first real proposal.

## policy.autonomy_grant

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| component_id | uuid? | null = all components (004) |
| environment | text? | null = all environments |
| issue_kind | text? | null = all kinds (001 FR-001) |
| action_key | text | FK `policy_action` |
| level | int | 0–5; **check constraint** `level <= ACTION_CEILING(action_class, has_tested_undo)` (R-05, C-18). A `reversible_remediation` grant additionally fails at grant time with `UNDO_NOT_ATTESTED` while the catalogue undo has no passing test |
| granted_by | text | human actor |
| granted_at | timestamptz | |
| revoked_by | text? | |
| revoked_at | timestamptz? | set once; a revoked grant is never reactivated |

Index `(tenant_id, action_key, environment) where revoked_at is null`. A narrower grant never
widens a broader one — grants are additive and the ceiling clamps the maximum, so overlapping grants
cannot raise a level above what either grants alone.

> Implementation note (T035): the `level` check is a `BEFORE INSERT OR UPDATE` trigger
> (`policy_autonomy_grant_ceiling`, migration `20261003060000_autonomy_grant_ceiling`), not a
> plain `CHECK` — Postgres `CHECK` constraints cannot reference another table, and the ceiling
> depends on `policy_action.action_class`, resolved via `action_key`. The trigger mirrors
> `ceiling.ts` for the three classes this repository can attest today (`read_only`, `code_change`,
> `repository_write`); `reversible_remediation` has no level in the trigger at all, because
> `has_tested_undo` has no data source until 010's catalogue lands — more conservative than
> `ceiling.ts`'s own answer once attested, never less. `gate-ceiling` (T038) keeps the two
> mechanisms' literals from drifting apart.

## policy.autonomy_epoch

`tenant_id` (PK), `epoch` bigint, `bumped_at`, `bumped_by`, `bump_reason`.

Incremented by every grant revocation. An outstanding `approval_request` whose recorded epoch no
longer matches is invalid at redemption (R-07). One row per tenant; the increment is the single
write that makes revocation immediate.

## policy.policy_decision (append-only)

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| issue_id | uuid? | |
| workflow_run_id | uuid? | 012 — the run this decision is bound to |
| workflow_state | text? | the guarded step |
| action_key | text | FK `policy_action` (batch 9 C1(b) — a decision recorded against an action key the registry does not have is unrepresentable) |
| target_ref | text? | the target the action was proposed against — the limit scope (C-11) |
| fingerprint | text? | the issue fingerprint (001 FR-002) — the other half of the limit scope |
| proposal_digest | text | canonical hash of the `DecisionInput`; a decision is valid for this digest only |
| decision_input | jsonb | the full closed record, stored for replay (R-03) |
| ruleset_version | int | resolves forever (FR-004, SC-003) |
| matched_rule_keys | text[] | |
| outcome | enum | `allow` · `require_approval` · `deny` |
| reason_codes | text[] | |
| ceiling_applied | bool | true when the clamp changed the outcome (R-05) |
| budget_state | jsonb | consumed, limit, declared max of the next step, degradation step |
| request_key | text? | a *charged* step's idempotency key: the caller's request with every resolved field and the instant removed. Partial unique index `(tenant_id, workflow_run_id, workflow_state, request_key)` over live allowed decisions, so a retried step returns the decision it already minted instead of charging twice (T060) |
| evaluated_at | timestamptz | passed in, not read from a clock inside the evaluator |
| consumed_at | timestamptz? | set when the guarded step executes against it |
| invalidated_reason | text? | `epoch_bump` · `approval_expired` · `approval_rejected` · `digest_mismatch` · `charge_abandoned` |

`UPDATE` is rejected except for `consumed_at` and `invalidated_reason` transitioning from null.

Index `(tenant_id, action_key, target_ref, fingerprint, evaluated_at)` — also the index the rate,
cooldown and attempt-cap predicates read (R-13, C-11). Index `(workflow_run_id)`.

## policy.approval_request

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| decision_id | uuid | the `require_approval` decision |
| workflow_run_id | uuid | 012 |
| summary | jsonb | proposed action, reason codes, ruleset version, target identifiers, impact summary, rollback plan (FR-015) — a **closed shape** built from the stored decision, never from caller input (`approvalSummarySchema`, T070/T071) |
| evidence_ids | uuid[] | 001 — the approver sees the evidence, not a narrative |
| autonomy_epoch | bigint | recorded at issue; re-checked at redemption (R-07) |
| expires_at | timestamptz | projected onto `workflow_run.deadline_at` |
| state | enum | `pending` · `approved` · `rejected` · `expired` · `revoked` |
| resolved_by | text? | the human, for `approved` and `rejected` (FR-017) |
| resolved_at | timestamptz? | |

Unique `(decision_id)`. Index `(tenant_id, state, expires_at)`.

`summary` holds identifiers and structured fields. Collected customer text never enters it: an
approval screen that renders attacker-influenced prose is a phishing surface aimed at the one human
whose click authorises a mutation.

> Implementation notes (T070–T076). **No migration**: the table, its `(decision_id)` uniqueness and
> the `(tenant_id, state, expires_at)` index already existed from T002.
>
> - *Unrepresentable, not checked.* `RequestApproval` accepts no summary from its caller. It builds
>   one from the stored `policy_decision` (closed enums, booleans, counts) and every free-string
>   slot must match the identifier alphabet (no whitespace), so a sentence of collected text has no
>   slot to occupy — it fails the parse instead of being rendered. Evidence appears only as
>   `evidence_ids`, never as an excerpt.
> - *The ruleset version a human decided under* is the immutable `policy_decision.ruleset_version`
>   of the decision the request is `decision_id` for; it is read through that join and written into
>   the resolution's `audit_entry`, so there is no second column to drift from it.
> - *Projection (R-09).* `expires_at = min(requested, run.deadline_at)` and the run's `deadline_at`
>   is set to that value in the same transaction that creates the request, under `FOR UPDATE` on the
>   run. With neither an expiry nor a run deadline the request is refused: nothing would fire it.
> - *Races.* `ResolveApproval`, `ExpireApproval` and the revocation sweep all lock the request row
>   `FOR UPDATE` and re-check `state = pending` under it; `ResolveApproval` additionally reads the
>   tenant's `autonomy_epoch` `FOR SHARE` in the same transaction. Exactly one of resolve and
>   expire wins; a request past `expires_at` is refused for resolution even before its tick fires.
> - *A lapse is recorded, not evaluated.* `ExpireApproval` writes a `policy_decision` with outcome
>   `deny`, reason `APPROVAL_EXPIRED`, **no matched rule keys**, and the original decision's input,
>   digest and ruleset version; it also sets the original decision's
>   `invalidated_reason = 'approval_expired'`. `check:decision-replay` skips exactly that shape
>   (no input replays to a rule-less deny).
> - *`check:stale-approvals`* reports a `pending` request past `expires_at` (plus a grace window), one
>   whose run has no deadline at or after `expires_at`, one whose run is terminal or does not exist,
>   one whose own `approval` callback is absent or already consumed, and — the other direction — a
>   live run `awaiting` an approval that no pending request backs.
>
> Review follow-up (one migration, `20261003100000_approval_callback_binding`):
>
> - *`workflow_callback.approval_id`* (012's table, nullable, unique, no FK so 012 does not depend on
>   002). An `approval` callback is bound to exactly one request and every delivery — resolve, expire,
>   revoke — finds it by that key, never by run. A delivery that matches no row is an error and rolls
>   the surrounding transaction back.
> - *One outstanding approval per run.* `RequestApproval` refuses (`ApprovalAlreadyPendingError`,
>   409/CONFLICT) when the locked run already has a `pending` request or is `awaiting` something other
>   than an approval; a run whose marker is a *resolved* approval's may be re-parked. Resolving
>   clears `awaiting`.
> - *Decision-time epoch.* `RequestApproval` takes the epoch `evaluateAndBind` returned, records it,
>   and refuses (`STALE_AUTONOMY_EPOCH`) if it is no longer current; it also refuses a consumed or
>   invalidated decision, and an empty `evidence_ids`.
> - *`rejected`* invalidates the original decision (`invalidated_reason = 'approval_rejected'`),
>   delivers the callback and moves the run to `needs_human` (cause `human`). `ResolveApproval` locks
>   the run and refuses (`ApprovalRunTerminalError`) when it is already terminal.
> - *The revocation sweep* revokes, invalidates the decision, delivers the callback, moves the run to
>   `needs_human` (cause `policy`) and writes a `policy.revoke_approval` audit entry in one transaction.
> - *`check:decision-replay`* exempts a lapse only when an `expired` request on the same run, an
>   original decision with `invalidated_reason = 'approval_expired'` and the same digest all exist.

## policy.budget_limit

Per-issue limits, and the per-tenant-period limits inherited from 012's `tenant_budget`.

`id`, `tenant_id`, `scope_type` (`issue` · `tenant`), `scope_id?`, `period` (`issue` · `day` ·
`month`), `spend_limit`, `time_limit_ms`, `soft_threshold_pcts` int[], `escalation_attempt_cap`,
`updated_at`, `updated_by`.

`soft_threshold_pcts` is an array because degradation has ordered steps (R-12); 012's
`tenant_budget.soft_threshold_pcts` is the same shape, which is what makes the per-tenant-period
limits inheritable rather than convertible.

Scope and period pair as `issue`/`issue` (the per-issue limit, with `scope_id` NULL meaning "every
issue of the tenant" and an issue id meaning an override for that one) or `tenant`/`day|month`
(`scope_id` NULL). Unique on `(tenant_id, scope_type, coalesce(scope_id, nil-uuid), period)`; the PUT
is an upsert on that key. **Which limit applies** (T057, pure, `budget-limits.ts`): for the issue, its
own row, then the per-issue default row, then the product default; for a tenant period, a
`budget_limit` row, then 012's `tenant_budget` row (inherited as it stands; its `time_limit` is read
as milliseconds), then the product default. There is no path to "unbounded".

**Product bounds (T088, FR-021).** Literal maxima as CHECK constraints in migration
`20261003090000_budget_limit_bounds`, the same values as constants in
`packages/domain/policy/src/domain/budget-bounds.ts`, with `budget-bounds.test.ts` failing if the two
disagree: `escalation_attempt_cap` 0–5; `spend_limit` 50 (issue) / 500 (day) / 5000 (month);
`time_limit_ms` 4 h / 24 h / 20 days; `soft_threshold_pcts` at most 5 entries, each within 1–99. The
fail-closed defaults for every unset value sit in the same file (`BUDGET_DEFAULTS`): spend 2 / 20 /
200, time 1 h / 8 h / 80 h, thresholds 50·75·90, escalation cap 2.

**Binding is validated, not assumed.** A named issue or workflow run that does not exist for the
tenant (or is another tenant's) is a not-found error before anything is read or charged — never a
fresh window or a zero count. An *enforcing* evaluation also refuses an `evaluated_at` more than
`MAX_EVALUATION_SKEW_MS` (5 min) from the database clock, because the instant selects the window
and a backdated one would be a fresh budget; a dry run replays history and is not so bound.

**Time counts active run time only.** `workflow_run` elapsed excludes the intervals a run was
*parked*: from a transition into a state named `awaiting_*` (or `needs_human`) until its next
transition, derived from `workflow_transition`. 012's workflow definitions have not named their
waiting states, so the prefix is policy's one declaration of the convention.

**Abandoned charges.** An allowed, never-consumed decision with no `agent_run` older than
`ABANDONED_CHARGE_TTL_MS` (2 h) is released by `releaseAbandonedCharges`
(`invalidated_reason = 'charge_abandoned'`), which stops its open charge counting. No production
caller schedules it. A *consumed* decision cannot be invalidated (the terminal XOR), so a step that
started and never finished keeps its charge until its run is finalised.

**Consumption** is derived on every call, never stored:
spend = Σ `agent_run.cost` + the declared maximum of every allow `policy_decision` that has not yet
been matched by a *finished* `agent_run` (its open charge, `budget_state.reservedSpend`, R-11);
time = Σ `workflow_run` elapsed (to `updated_at` when terminal, to the evaluation instant while
live). A tenant period is keyed by the **workflow run's start** (`workflow_run.started_at`, found
for an agent run through `correlation_id`, for a decision through `workflow_run_id`), so a run that
straddles midnight stays in the window in force when it was requested (T062). An agent run or
decision that happened *before* its workflow was started (classified at ingest, say) is keyed by its
own earlier instant — `LEAST` of the two — which is also what makes pruning the scan on
`started_at >= window.start` sound. `check:budget-reconcile` recomputes all of the above in JS from
the raw rows and compares it with the SQL aggregate; it found the pruning gap that `LEAST` closes.

## policy.action_limit

The rate limits, cooldowns and attempt caps of FR-014, **owned here and nowhere else** (C-11): the
deterministic engine that already writes a trace and a reason code is the only place a limit can be
enforced and still be explicable a year later.

`tenant_id`, `action_key`, `rate_per_window`, `window_seconds`, `cooldown_seconds`, `attempt_cap`,
`updated_at`, `updated_by`. PK `(tenant_id, action_key)`.

Counts are **not** stored: they are aggregated from `policy_decision` history for
`(action_key, target_ref, fingerprint)` in the same query that loads the rule set (R-13). Values are
placeholders until stage-0 supplies grounds for them; the *existence* of each bound is not
configurable. 010 keeps no limit store and projects only the refusal reason codes.

Consumption is **not** stored. It is aggregated from `agent_run` and `workflow_run` (012 FR-036,
R-10). Default values are placeholders until the stage-0 benchmark exists.

## policy.budget_degradation_mark

`tenant_id`, `scope_type`, `scope_id`, `period_key`, `step` — composite PK. `evidence_id`,
`marked_at`.

The idempotency key for "this degradation step has already been recorded as evidence" (R-12).
Carries no state of its own; the state is the evidence record.

`scope_id` is the issue id for `scope_type = issue` and the tenant id for `scope_type = tenant`
(the column is NOT NULL). `step` runs 1..n for the n soft thresholds and **n + 1 is exhaustion**
(entry `ai_steps_refused`), recorded like any other step. The mark is inserted with
`ON CONFLICT DO NOTHING` in the same transaction as the evidence record: a concurrent writer of the
same key blocks on the primary key until the first commits, then skips, so exactly one transaction
writes the evidence. The evidence id is a deterministic function of the key, so even a retry after a
crash names the same row. The record's `produced_by_step` is `policy.mark_degradation`; its payload
carries the scope, period key, step, entry applied, dimension (`spend`/`time`) and consumed and
limit figures — and, on a per-issue exhaustion, the agent runs completed so far.

## State transitions

```text
policy_ruleset:   published ──publish new content──▶ superseded (both remain readable)

autonomy_grant:   active ──revoke──▶ revoked (terminal; epoch bumped in the same transaction)

policy_decision:  issued ──guarded step executes──▶ consumed
                  issued ──epoch bump | approval expiry | digest mismatch──▶ invalidated
                  (a decision is never re-used for a second execution)

approval_request: pending ──human──▶ approved | rejected
                  pending ──deadline tick──▶ expired  ──▶ run to needs_human, DENY recorded
                  pending ──grant revoked──▶ revoked  ──▶ run to needs_human, DENY recorded
                  (no transition leads to the action proceeding by default)

budget scope:     within ──soft threshold crossed──▶ degraded(step n), monotone within the period
                  degraded ──limit reached──▶ exhausted ──▶ AI steps refused, workflow suspends
                                                            resumably; work done is not discarded
```

## Invariants

- Every executed mutating action has exactly one `policy_decision` with `outcome = allow` and
  `consumed_at` set, whose `proposal_digest` equals the digest of what executed. Verified by
  continuous reconciliation against `audit_entry`, not only in tests (SC-001, R-14).
- A decision is consumed at most once. A second execution against the same decision is refused with
  `DECISION_ALREADY_CONSUMED`. Consumption is refused with `DECISION_NOT_ALLOWED` when the decision's
  own `outcome` is not `allow`, or when its `invalidated_reason` is set — a `deny`/`require_approval`
  decision, or one since invalidated, never becomes consumable (batch 9 C1(a)).
- `evaluate(ruleset_version, decision_input) = (outcome, matched_rule_keys)` replays identically for
  every stored decision. A nightly replay over a sample is the check (FR-002, SC-002).
- `DecisionInput` contains no field derived from model output other than structured proposals whose
  values are themselves structural; no confidence value exists anywhere in the record (FR-003).
- No change raising a level in `ACTION_CEILING` reaches the default branch without a resolvable
  `threshold_derivation` artifact cited in the diff — the ceiling is data-enforced by `gate-ceiling`, and
  the edit to the ceiling is diff-enforced by the same gate (FR-008a, R-15, 011 FR-021c).
- No `autonomy_grant` exists with `level > ACTION_CEILING(action_class, has_tested_undo)`, and no
  evaluation returns an outcome above that clamp even if such a row were written (FR-008, SC-004)
  — see the implementation note under `policy.autonomy_grant` (T035).
- No `autonomy_grant` of class `reversible_remediation` exists for an action whose catalogue undo is
  unattested, and no evaluation grants such an action a level — the ceiling has none (C-18).
- No grant exists for an action of class `merge`, `forward_deploy` or `irreversible` in this
  release — the ceiling has no level for them (008 FR-024).
- Every `policy_decision.ruleset_version` resolves to an existing `policy_ruleset` (SC-003).
- An `approval_request` in state `pending` has an `expires_at` no later than its run's
  `deadline_at`, so expiry always has a tick that will fire it (012).
- An approval redeemed with a stale `autonomy_epoch` is refused (FR-007).
- Consumed spend plus the declared maximum of the next step never exceeds the period limit
  (SC-006, R-11).
- `degradation_step` is monotone within a period; each step has at most one
  `budget_degradation_mark` and exactly one evidence record (FR-012).
- Every read is constrained by `tenant_id` from the authenticated context; a foreign identifier
  returns not-found, never forbidden (FR-018, SC-008).
