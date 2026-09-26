# Data Model: diagnosis

Schema `diagnosis`. Identifiers are UUID v7; timestamps `timestamptz` UTC. Every table carries
`tenant_id` with an index `(tenant_id, …)` ([prisma rules](../../.claude/rules/prisma-migrations.md)).

Tables owned elsewhere and only referenced here: `issue.issue`, `evidence.evidence`,
`evidence.evidence_link`, `audit.audit_entry` (001); `workflow_run`, `agent_run`, `prompt_version`
(012); `context_snapshot` (003); `expected_behavior` and its versions (005); component and graph
version (004).

## diagnosis.classifier_ruleset

`version` (PK), `rules` jsonb, `classes` text[], `published_at`, `note`. Never edited; a change is a
new version (R-02). Every classification records the version that produced it, so a verdict from
March is explicable in October.

`classes` is the closed taxonomy list of FR-001, `knowledge_drift` included (R-16).

## diagnosis.issue_classification (append-only)

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| issue_id | uuid | FK `issue.issue` |
| snapshot_id | uuid | the `ContextSnapshot` classified (003) |
| ruleset_version | int | FK `classifier_ruleset` |
| taxonomy_class | text | must be a member of that ruleset's `classes` |
| secondary_classes | text[] | populated when signals conflict (`UNDETERMINED`) |
| verdict | enum | `CODE_PROBLEM` · `NOT_A_CODE_PROBLEM` · `UNDETERMINED` |
| decided_by | enum | `signal_rules` · `model` · `human` |
| fired_rules | text[] | which signal rules matched (R-02) |
| agent_run_id | uuid? | null when `decided_by = signal_rules` — no model was called |
| override_of_id | uuid? | FK self; set when `decided_by = human` (FR-003) |
| override_reason | text? | required when `override_of_id` is set |
| produced_by_step | text | (001 FR-008) |
| created_at | timestamptz | |

Append-only. A re-classification or a human override is a new row; the latest row per issue is
current. `UPDATE` and `DELETE` rejected by rule.

Index `(tenant_id, issue_id, created_at desc)`.

Every row requires ≥ 1 `evidence_link` with `conclusion_type = 'classification'` (FR-003).

## diagnosis.diagnosis (append-only versions)

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| issue_id | uuid | FK `issue.issue` |
| classification_id | uuid | **NOT NULL** — the ordering constraint (R-01, R-03) |
| snapshot_id | uuid | 003 |
| graph_version | bigint | pinned for the run (004 FR-014) |
| attempt_no | int | unique `(issue_id, attempt_no)`, check `attempt_no <= 2` (R-10, D-08) |
| trigger | enum | `initial` · `rediagnosis_after_rejection` |
| rejection_reason | text? | received from the verifier or the human (008 FR-017) |
| outcome | enum | `ROOT_CAUSE_IDENTIFIED` · `UNKNOWN` · `INSUFFICIENT_CONTEXT` · `NOT_A_CODE_PROBLEM` |
| termination_reason | enum | `completed` · `budget_exhausted` · `escalation_cap` (R-12) |
| root_cause_statement | text? | null unless outcome is `ROOT_CAUSE_IDENTIFIED` |
| unexamined | jsonb | what was not reached when terminated early |
| agent_run_id | uuid | FK 012 `agent_run` — model, prompt version, tokens, cost (FR-022) |
| produced_by_step | text | |
| created_at | timestamptz | |

Check: `root_cause_statement IS NOT NULL` **iff** `outcome = 'ROOT_CAUSE_IDENTIFIED'` (SC-006).

Index `(tenant_id, issue_id, attempt_no)`.

No `confidence` column. See `diagnosis_confidence`.

## diagnosis.diagnosis_confidence

`diagnosis_id` (PK, FK), `tenant_id`, `value` numeric, `scale` text, `recorded_at`.

Separate table on purpose (R-09, FR-015). Read only by the evaluation surface (011). Neither
`packages/domain/policy/**` nor the `fix_eligibility` view references it, enforced by the
pattern-based import rule (012 FR-003).

## diagnosis.hypothesis

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| diagnosis_id | uuid | FK |
| statement | text | |
| statement_fingerprint | text | normalised hash; carries exclusions across attempts (R-11) |
| status | enum | `CANDIDATE` · `SUPPORTED` · `REFUTED` · `UNVERIFIABLE` |
| contradiction_explanation | text? | required to promote a hypothesis carrying `contradicts` links (FR-008) |
| excluded | bool | carried over from a rejected attempt |
| exclusion_reason | text? | required when `excluded` |
| is_root_cause | bool | at most one true per diagnosis |
| created_at | timestamptz | |

Supporting and contradicting evidence are `evidence_link` rows with
`conclusion_type = 'hypothesis'`, `conclusion_id = hypothesis.id` and relation `supports` or
`contradicts` — they are not columns here (001 owns links).

Partial unique index: one `is_root_cause = true` per `diagnosis_id`.

Check enforced by `gate-evidence` and a continuous check: `is_root_cause = true` requires either no
`contradicts` link or a non-null `contradiction_explanation` (FR-008).

## diagnosis.disconfirming_search

`id`, `tenant_id`, `hypothesis_id` (unique — exactly one per hypothesis), `searched` jsonb
(evidence types, source systems, time window, queries issued), `outcome` enum
(`found` · `none_found`), `performed_at`.

`outcome = 'none_found'` with an empty `searched` is rejected (R-06). A hypothesis with no row is
incomplete and cannot be read as a result — SC-004 is the reconciliation.

## diagnosis.expectation_violation

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| diagnosis_id | uuid | FK |
| expectation_id | uuid? | FK 005 `expected_behavior`; null when `NO_EXPECTATION` |
| expectation_version_id | uuid? | pinned citation (005 FR-019) |
| state | enum | `violated` · `no_expectation` |
| adopted_at | timestamptz? | copied at write time (R-05) |
| issue_first_seen_at | timestamptz | copied at write time |
| pre_existing | bool | derived: `adopted_at < issue_first_seen_at` |
| expected_statement | text? | quoted from the adopted entry, never paraphrased (R-04) |
| observed_statement | text | from evidence |
| created_at | timestamptz | |

At most one row per diagnosis. `state = 'no_expectation'` marks the issue ineligible for the
automated fix path (FR-011) through the view below; a machine-generated, unadopted document can
never appear here (FR-010, 005 FR-008).

## diagnosis.precedent_candidate

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| diagnosis_id | uuid | FK |
| referenced_issue_id | uuid | FK `issue.issue`, same tenant (FR-027) |
| similarity_basis | enum | `fingerprint` · `component_and_signature` · `vector` |
| similarity_score | numeric | |
| age_days | int | |
| liveness | enum | `present` · `moved` · `absent` — resolved against the current graph version, conditions in R-19 (C-22) |
| liveness_checked_at | timestamptz | |
| stale | bool | derived: `liveness = 'absent'` |
| weight | numeric | `similarity × 0.5^(age_days/half_life) × liveness_factor` |
| evidence_ids | uuid[] | the precedent's own evidence records — the only citable part |

**There is no column holding the precedent's conclusion** (R-08, FR-020). An `evidence_link`
citing evidence from a `stale` precedent's set is rejected (FR-019).

Index `(tenant_id, diagnosis_id)`, `(tenant_id, referenced_issue_id)`.

## diagnosis.diagnosis_affected_component

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| diagnosis_id | uuid | FK |
| component_id | uuid | 004, resolved at `diagnosis.graph_version` (FR-016, R-15) |
| relation | enum | `primary` · `dependency` · `dependent` |
| resolved_from_edge_path | jsonb | the graph path that put it in the set (004 FR-015) |
| confidence_class | enum | 004 edge provenance (004 FR-005..007) — **not** model confidence (R-09) |
| removed_from_graph | bool | set when the component is later absent from the graph; the row is retained and flagged, never deleted (R-18) |

Unique `(diagnosis_id, component_id)`. Index `(tenant_id, diagnosis_id)`.

This is what the contract's `affectedComponentIds` reads (R-18). Resolution reads an `ImpactClosure`
from 004 at the pinned graph version, so the set is reproducible; a name that does not resolve is
never inserted here — it is dropped and recorded as an `unknown_component` anomaly (FR-016, R-15).

## diagnosis.missing_evidence_item

`id`, `tenant_id`, `diagnosis_id`, `evidence_type`, `source_system`, `window_start`, `window_end`,
`why_blocking` text, `gap_evidence_id` uuid **NOT NULL**.

`gap_evidence_id` references a `collection_gap` evidence record — from 003's source outcomes and
withheld items, or emitted by the diagnosis step itself where 003 never planned that source (R-07).
This is what makes `INSUFFICIENT_CONTEXT` persistable under 001 FR-009 and SC-006 checkable.

## diagnosis.reproduction_directive

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| diagnosis_id | uuid | unique — one directive per diagnosis |
| observable_location | enum | `server` · `client` · `undetermined` — selects 007's ladder (R-20, 007 R-22). Derived from evidence, never from `issue.kind` |
| suggested_rung | text | from 007's frozen vocabulary for the selected ladder (R-13, R-20) |
| max_rung | text | ceiling; 007 always starts at the cheapest rung of that ladder |
| entry_point | jsonb | component, symbol or endpoint template, resolved against 004 |
| preconditions | jsonb | declared state the rung requires |
| failing_observable | jsonb | the issue's normalised error signature (001 FR-002, FR-003) |
| data_requirements | jsonb | field presence, types, bounds — shape only, never a value (007 FR-024) |
| created_at | timestamptz | |

Shape and rung vocabulary are normatively defined in
[007/contracts/ladder.md](../007-reproduction-and-sandbox/contracts/ladder.md); not restated here.

## diagnosis.diagnosis_anomaly (append-only)

`id`, `tenant_id`, `diagnosis_id`, `kind` enum (`unknown_component` · `instruction_shaped_content` ·
`schema_validation_failure` · `precedent_liveness_unavailable`), `detail` jsonb, `occurred_at`.

Anomalies are recorded, never silently corrected (R-14, R-15).

## diagnosis.fix_eligibility (view — no write path)

```sql
-- eligible only when three independent facts hold; absence of any row yields false.
-- coalesce is load-bearing: with no classification, violation or diagnosis row the conjunction
-- is NULL, not false, and a NULL read as a boolean is not the safe direction.
select i.tenant_id, i.id as issue_id,
       coalesce(c.verdict = 'CODE_PROBLEM'
        and v.state = 'violated' and v.pre_existing
        and d.outcome = 'ROOT_CAUSE_IDENTIFIED', false)      as eligible,
       array_remove(array[
         case when c.verdict is distinct from 'CODE_PROBLEM'  then 'classification' end,
         case when v.state is distinct from 'violated'        then 'no_expectation' end,
         case when not coalesce(v.pre_existing, false)        then 'expectation_not_pre_existing' end,
         case when d.outcome is distinct from 'ROOT_CAUSE_IDENTIFIED' then 'outcome' end
       ], null)                                               as blocked_by
from issue.issue i
left join lateral (…latest classification…) c on true
left join lateral (…latest diagnosis…)      d on true
left join diagnosis.expectation_violation   v on v.diagnosis_id = d.id;
```

Read by the policy engine (002 FR-001) and by 008 at fix-loop entry (C-08). No row, or any conjunct
false, means not eligible; 002 FR-005 turns the absence of a matching rule into `DENY`, so a missing
classification and a refused one behave identically (R-03). SC-001 reconciles change proposals
against this view continuously.

**Conjunct 2 is advisory.** `pre_existing` is derived from timestamps this feature copied onto
`expectation_violation` — a fact from inside the same chain. **008's `anchor_resolution` is
authoritative** for whether an anchor exists, names a live `anchor_grant` and pre-dates the issue
(008 R-04, C-12). A `false` here is binding on policy; a `true` grants nothing and 008 re-resolves
against 005 regardless.

## Cross-feature additions this feature requires

`evidence.evidence_link.conclusion_type` (001 data model) currently enumerates
`diagnosis · hypothesis · impact · verification · support_answer · remediation`. Classification is a
persisted conclusion requiring evidence (FR-003), so the enum needs **`classification`**. Additive,
no behaviour change; raised as a spec gap rather than worked around with `conclusion_type =
'diagnosis'`, which would make classification links indistinguishable from diagnosis links in the
evidence graph.

## State transitions

```text
classification:  (none) ──classify──▶ CODE_PROBLEM | NOT_A_CODE_PROBLEM | UNDETERMINED
                 any ──new run or human override──▶ new row (previous retained)

diagnosis:       attempt 1 ──REJECT_DIAGNOSIS──▶ attempt 2 ──REJECT_DIAGNOSIS──▶ human
                 any ──budget or escalation cap──▶ INSUFFICIENT_CONTEXT + termination_reason

hypothesis:      CANDIDATE ──supporting evidence──▶ SUPPORTED ──contradicted──▶ REFUTED
                 CANDIDATE ──no evidence can settle it──▶ UNVERIFIABLE
```

## Invariants

- Every `diagnosis` row references a `classification_id`; no insert order produces a hypothesis
  before a verdict.
- No issue has more than two `diagnosis` rows without a human in the record.
- Every hypothesis has exactly one `disconfirming_search`.
- `is_root_cause` is true for at most one hypothesis per diagnosis, and never while an unexplained
  `contradicts` link stands.
- `root_cause_statement` is non-null exactly when the outcome is `ROOT_CAUSE_IDENTIFIED`, and
  carries ≥ 1 `evidence_link` whose evidence is verified to support it (FR-014, SC-003).
- Every `missing_evidence_item` resolves to an existing `collection_gap` evidence record.
- No `evidence_link` cites evidence from a `stale` precedent as `supports` for a root cause.
- No row in `issue_classification`, `diagnosis_anomaly` or `evidence_link` is ever updated.
- `diagnosis_confidence` appears in no query reachable from the policy package or the eligibility
  view.
- Every read is constrained by `tenant_id` from the authenticated context; a foreign identifier
  returns not-found — precedent retrieval included.
