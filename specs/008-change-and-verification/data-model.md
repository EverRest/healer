# Data Model: impact analysis, TDD fix, independent verification, pull request

Schema `change`. Identifiers are UUID v7; timestamps `timestamptz` UTC. Every table carries
`tenant_id` with an index `(tenant_id, …)` (012 FR-048,
[prisma rules](../../.claude/rules/prisma-migrations.md)).

Referenced, never redefined here: `issue.issue`, `evidence.evidence`, `evidence.evidence_link`,
`audit.audit_entry` (001); `workflow_run`, `workflow_callback`, `prompt_version`, `agent_run`
(012); `PolicyDecision` and `ApprovalRequest` (002); `knowledge.expected_behavior`,
`knowledge.expected_behavior_version`, `knowledge.anchor_grant`, `knowledge.adoption_record` and
`knowledge.knowledge_constraint` (005 — the table names as 005's data model spells them); execution
records and the `change_eligibility` view (007); `diagnosis.fix_eligibility` (006); `Component` and
graph elements (004).

## change.impact_analysis

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| issue_id | uuid | 001 |
| repository_id | uuid | 004 |
| analysed_commit | text | the tree the graph describes (R-17) |
| target_ref | text | symbol or file the analysis started from |
| classification | enum | `critical` · `high` · `medium` · `low` |
| classification_ruleset_version | int | predicate→tier table version (R-03) |
| touch_predicates | jsonb | each `{predicate, true/false, graph_path}` (004 FR-015) |
| coverage_gaps | jsonb | unsupported languages and untested surfaces (R-21, R-22) |
| graph_node_count, graph_edge_count | int | |
| runner_id | uuid | which runner produced it (012) |
| produced_by_step | text | for evidence attribution (001 FR-008) |
| created_at | timestamptz | |

Index `(tenant_id, issue_id, created_at)`, `(tenant_id, repository_id, analysed_commit)`.

`touch_predicates` is the **whole** classifier input. File count, line count and diff size are not
columns here and are not passed to the classifier (R-03, FR-003).

## change.change_graph_node

`id`, `tenant_id`, `analysis_id`, `kind` (`symbol` · `file` · `component` · `contract` · `db_model` ·
`migration` · `test` · `event` · `feature_flag`), `ref` (repository-relative path, symbol name or
contract key), `component_id?` (004), `attributes` jsonb.

Unique `(analysis_id, kind, ref)`. Index `(tenant_id, analysis_id, kind)`.

## change.change_graph_edge (append-only within an analysis)

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| analysis_id | uuid | |
| from_node_id, to_node_id | uuid | |
| relation | enum | `references` · `calls` · `types` · `implements` · `persists_to` · `migrates` · `covers` · `publishes` · `consumes` · `guarded_by` |
| derivation | enum | `symbol_reference` · `type_graph` · `call_graph` · `contract` · `db_model` · `migration` · `test_map` · `event_topic` · `feature_flag` |
| confidence_class | enum | from 004 provenance (004 FR-005..007) |

No `UPDATE`, no `DELETE`, no `active` flag, no soft-delete column. Re-analysis creates a new
`analysis_id` (R-02).

## change.change_graph_annotation (additive only)

`id`, `tenant_id`, `analysis_id`, `kind` (`added_edge` · `note`), `from_node_id?`, `to_node_id?`,
`relation?`, `edge_id?`, `note` text, `agent_run_id` (012), `created_at`.

An `added_edge` annotation carries `derivation = model_inferred` implicitly and may only widen blast
radius or raise the tier — never narrow or lower (004 FR-016a, C-03). There is no annotation kind
that removes, suppresses or downgrades a deterministic edge, and no query filters
`change_graph_edge` by any annotation field (R-02).

## change.anchor_resolution

The record that makes Principle II checkable. Produced by a deterministic step before the change
agent runs; the change agent cannot write it (R-04, R-05).

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| issue_id | uuid | |
| verdict | enum | `ANCHORED` · `NO_EXPECTATION` · `ADOPTED_AFTER_ISSUE` · `REVOKED` · `VERSION_NOT_READOPTED` |
| anchor_grant_id | uuid | **NOT NULL when `verdict = ANCHORED`** — 005 `anchor_grant`, the only thing that can name an anchor (C-12, 005 data model R-01). Null for every other verdict |
| expectation_id | uuid? | 005 `expected_behavior` |
| expectation_version_id | uuid? | 005 `expected_behavior_version.id` — the version the test asserts (005 FR-012) |
| expectation_version_no | int? | that version's `version_no`, copied for human-readable citation |
| adoption_record_id | uuid? | 005 `adoption_record` |
| adopted_at | timestamptz? | **immutable copy** from the adoption record; **must be < `issue.first_seen_at`** |
| adopted_by_actor_type | enum? | **immutable copy**; must be `human` (005 FR-011) |
| issue_first_seen_at | timestamptz | copied at resolution so the comparison is reconstructable |
| constraint_kinds | text[] | positive kinds enable the masking exception (R-11) |
| resolved_at | timestamptz | |

Index `(tenant_id, issue_id)`. Only `verdict = ANCHORED` opens the fix path (FR-006, FR-007).

Check: `anchor_grant_id IS NOT NULL` **iff** `verdict = 'ANCHORED'`.

**There is no `state = adopted` predicate anywhere in this resolution** (C-12). `state` is a display
column in 005 that no anchor query reads; the grant is what names an anchor, so an unadopted
expectation is *unnameable* rather than rejected. And `adopted_at` and `adopted_by_actor_type` are
copies, not joins: `adopted_at < issue.first_seen_at` must stay reconstructable years later, after the
grant has been revoked and the adoption record read only through its id (005 FR-013).

## change.change_plan

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| issue_id | uuid | |
| version | int | plan extension creates a new version; none is deleted (FR-005) |
| reason | text | |
| impact_analysis_id | uuid | |
| classification | enum | copied from the analysis at submission |
| anchor_resolution_id | uuid | must be `ANCHORED` |
| policy_decision_id | uuid? | 002; null until evaluated |
| state | enum | `submitted` · `approved` · `rejected` · `superseded` · `invalidated` |
| created_at | timestamptz | |

Unique `(issue_id, version)`. A plan is `invalidated` on `REJECT_DIAGNOSIS` rather than extended
(R-14).

## change.change_plan_file

`plan_id`, `tenant_id`, `path`, `role` (`primary` · `dependent` · `test`). Unique `(plan_id, path)`.
The privileged applier validates every hunk path against this set for the **current** version
(R-15, FR-005).

## change.regression_test

`id`, `tenant_id`, `issue_id`, `attempt_id`, `test_identifier`, `file_path`,
`anchor_resolution_id`, `asserted_constraint_ref` (005 `knowledge_constraint`), `red_execution_id?`,
`green_execution_id?`, `signature_ruleset_version`, `fixture_source` enum
(`recipe` · `synthetic_equivalent`), `created_at`.

`asserted_constraint_ref` must resolve to a `knowledge_constraint` whose `document_version_id` is the
expectation version named in the anchor resolution. `fixture_source = synthetic_equivalent` records
the C-23 case: the reproducing rung's fixture was `anonymised` and had no recipe, so this test carries
a synthetic equivalent built to the failing constraint (FR-011a). SC-002's continuous check
(`check:anchor-precedence`) runs over this table joined to `anchor_resolution` and `issue` (R-05).

## change.fix_attempt

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| issue_id | uuid | |
| attempt_number | int | |
| plan_id, plan_version | uuid, int | |
| base_commit | text | the parent of the patch (R-07, R-17) |
| patch_ref | text | branch + commit of the applied patch |
| diff_digest | text | normalised diff hash — the change fingerprint (R-18) |
| approach_fingerprint | text | structural hash (R-20) |
| retry_reason | text? | **required** when `approach_fingerprint` matches a rejected attempt (FR-027) |
| state | text | current fix-loop state (`contracts/fix-loop.md`) |
| verdict_id | uuid? | |
| rejection_reason | text? | |
| stale | bool | base moved after analysis (R-17) |
| cost | numeric | rolled up from `agent_run` (012 FR-036) |
| created_at, closed_at | timestamptz | |

Unique `(issue_id, attempt_number)`. Index `(tenant_id, issue_id, attempt_number)`,
`(tenant_id, approach_fingerprint)`. **Rows are never deleted** (FR-026, SC-012).

## change.fix_loop_transition (append-only)

`id`, `tenant_id`, `attempt_id`, `seq` (monotonic), `from_state`, `to_state`, `guard_kind`,
`execution_id?` (007), `evidence_id?`, `cause` (`job` · `callback` · `policy` · `human`),
`occurred_at`.

Unique `(attempt_id, seq)` and `(attempt_id, to_state)`. Never updated, never deleted. This table
plus `workflow_transition` (012) is what SC-010 is checked against (R-07).

## change.test_baseline

`id`, `tenant_id`, `repository_id`, `commit_sha`, `test_command_digest`, `results` jsonb
(test id → outcome), `already_failing` text[], `captured_at`, `expires_at`.

Unique `(tenant_id, repository_id, commit_sha, test_command_digest)`. Reused across attempts on the
same base (R-08). `already_failing` non-empty is reported on the plan and in the pull request, never
used to excuse a new failure (FR-012).

## change.quarantined_test

`id`, `tenant_id`, `repository_id`, `test_identifier`, `commit_sha`, `observed_outcomes` text[],
`repeat_count`, `quarantined_at`, `expires_at`, `surfaced` bool.

Unique `(tenant_id, repository_id, test_identifier)` while unexpired. A quarantined test counts as
neither `PASS` nor `FAIL` proof (FR-013, SC-004). Quarantine expires and is re-measured (R-09).

## change.masking_finding

`id`, `tenant_id`, `attempt_id`, `pattern` (`catch_added` · `rejection_swallowed` ·
`retry_added` · `default_fallback` · `type_widened` · `assertion_loosened` · `test_weakened` ·
`test_skipped` · `test_deleted` · `expectation_document_modified`), `file_path`, `node_ref`,
`at_failure_site` bool, `behavioural_assertion_satisfied` bool, `disposition`
(`rejected` · `requires_human_approval`), `detected_at`.

`disposition = requires_human_approval` is only reachable when the anchor carries a positive
constraint kind and the regression test asserts it (R-11, FR-015). Detection is deterministic AST
inspection; no model writes to this table (R-10).

`pattern = expectation_document_modified` is a **hard refusal**: a check constraint pins its
`disposition` to `rejected`, so no approval path reaches it (FR-014a). It fires when a declared plan
path or a patch hunk path resolves to one of 005's expectation-defining markdown sources — the patch
would otherwise carry its own verification anchor past a reviewer who thinks they are approving a bug
fix. An expectation change is a separate merge request.

## change.verification_verdict

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| attempt_id | uuid | |
| verdict | enum | `APPROVE` · `REJECT_PATCH` · `REJECT_DIAGNOSIS` · `INSUFFICIENT_EVIDENCE` |
| anchors_available | jsonb | each `{kind, ref}` |
| anchors_used | jsonb | subset actually read |
| independence_rank_achieved | int | 5 production_signal · 4 human_written_test · 3 expectation_anchored_regression_test · 2 second_model · 1 self_review |
| reasons | jsonb | structured, schema-validated; not free prose |
| agent_run_id | uuid | 012 — carries model, prompt version, cost |
| model_confidence | numeric? | **recorded, never read by a gate** (FR-019) |
| decided_at | timestamptz | |

Constraint: `verdict = 'APPROVE'` requires `independence_rank_achieved >= 3` **and** at least one
entry in `anchors_used` whose kind is `adopted_expectation` or `raw_evidence` (R-13, FR-018,
SC-003). The verifying identity is the `agent_run`'s agent kind, which must be `verifier`, never
`change` (FR-016).

## change.pull_request_record

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| issue_id, repository_id | uuid | |
| target_branch, source_branch | text | |
| external_id | text? | provider identifier, set after creation |
| idempotency_key | uuid | |
| change_fingerprint | text | from `fix_attempt.diff_digest` |
| sections | jsonb | completeness state per mandated section (FR-021) |
| attempt_ids | uuid[] | every attempt reflected in this request (FR-022) |
| awaiting_ci | bool | true until required results return (R-24, FR-020) |
| update_history | jsonb | append-only list of updates |
| created_at, updated_at | timestamptz | |

Unique `(tenant_id, issue_id, repository_id, target_branch)` and `(tenant_id, idempotency_key)`.
Creation is refused when any mandated section is unpopulated (SC-006).

**There is no `merged_at`, no `merge_actor` and no merge action** — this record describes a request,
never its disposition by us (FR-024, R-19).

## change.rollback_plan

`id`, `tenant_id`, `attempt_id`, `revert_mechanism` (`revert_commit` · `redeploy_previous` ·
`feature_flag_off`), `data_consequence` text, `reversibility`
(`reversible` · `irreversible_by_default`), `requires_human_approval` bool.

`reversibility = irreversible_by_default` whenever the patch contains a migration, and
`requires_human_approval` is then true at every autonomy level (R-23, FR-023, 002 FR-009).

## change.component_verification_policy

`tenant_id`, `component_id` (PK together, 004), `e2e_required` bool **default true**, `declared_by`
text (the human who declared it), `declared_at` timestamptz, `note` text?.

The field FR-020's exemption needed (R-27). The `→ VERIFIED` guard reads it: without a row, or with
`e2e_required = true`, `VERIFIED` is reachable only through `E2E_RETURNED`. Default **true** because
the safe default is the stricter one — a component nobody configured must not skip end-to-end results.
Both the value and its declarer are printed in the pull request, so an exemption is visible to the
reviewer rather than implicit in a configuration table.

## change.repo_mutation_lease

`tenant_id`, `repository_id` (PK together), `attempt_id`, `acquired_at`, `expires_at`.

One live lease per repository. A plan that cannot acquire parks the workflow in
`AWAITING_REPO_LEASE` with a deadline; no job blocks (R-16, FR-029, 012 FR-025).

## Cross-feature additions this feature requires

`change_graph` is **not** in 012's closed boundary shape list
([012 runner-protocol](../012-engineering-foundation/contracts/runner-protocol.md), 012 FR-022), and
007 R-17 adds nothing to it either. R-01 has the runner computing the graph where the source is and
sending nodes and edges to the control plane, so the shape has to be **added there** — with
repository-relative paths, symbol names, `relation` and `derivation` only, and no file contents.

Raised as a spec gap against 012 FR-022 rather than worked around by shipping the graph inside
`tool_output_summary`, which 012's own contract text says would reopen the free-form channel the
closed list exists to close (C-20 applies the same reasoning to `pull_request_ref`, `config_key_ref`
and `knowledge_ref`). This is the same route 006 took for `conclusion_type = classification`.

## Invariants

- `regression_test` resolves to an `anchor_resolution` with `verdict = ANCHORED`, a non-null
  `anchor_grant_id`, `adopted_by_actor_type = human` and `adopted_at < issue_first_seen_at`. Checked
  continuously (SC-002), not only at write time.
- No `fix_loop_transition` out of `LOOP_ENTRY` exists for an issue whose `fix_eligibility.eligible`
  (006) or `change_eligibility.eligible` (007) was false at the time of the transition (C-08).
- No `change_plan_file` row and no applied hunk path resolves to an expectation-defining document; any
  such path is a `masking_finding` with `pattern = expectation_document_modified` and `disposition =
  rejected` (FR-014a).
- No `fix_loop_transition` to `GREEN_VERIFIED` exists without a preceding `RED_VERIFIED` transition
  for the same `regression_test_id`, whose execution's commit is the patch's parent and whose
  failure signature matched the issue's (SC-010).
- No file was modified outside `change_plan_file` for the plan version in force at the time of the
  write; every refused attempt is audited (SC-005).
- No `verification_verdict` with `verdict = 'APPROVE'` has `independence_rank_achieved < 3` (SC-003).
- No execution referenced as `PASS` or `FAIL` proof names a test that is quarantined on that
  repository (SC-004).
- No row in `change_graph_edge`, `fix_loop_transition` or `fix_attempt` is ever updated to remove
  content or deleted (R-02, FR-026).
- Every `impact_analysis`, `change_plan`, `fix_attempt`, `verification_verdict` and
  `pull_request_record` has ≥ 1 `evidence_link` asserted by its own producing step (001 FR-008,
  001 FR-009, FR-030).
- No merge-capable call exists in the tree; `gate-no-merge` fails the build otherwise, and merge
  events in the repository reconcile to non-Healer actors (SC-001).
- Every read is constrained by `tenant_id` from the authenticated context; a foreign identifier
  returns not-found (SC-013, 001 FR-015).
