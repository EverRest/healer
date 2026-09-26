# Data Model: regression suite

Schema `regression`. Identifiers are UUID v7; timestamps `timestamptz` UTC. Every table carries
`tenant_id` with an index `(tenant_id, …)` (012 FR-048).

Referenced, never redefined here: `issue.issue`, `evidence.evidence`, `evidence.evidence_link` (001);
`knowledge.expected_behavior`, `knowledge.expected_behavior_version`, `knowledge.anchor_grant` (005);
`architecture.graph_node` of kinds `endpoint`, `feature`, `flow`, `component`, `repository` (004);
`agent_run`, `workflow_run` (012); `ci_delegation` (007).

## regression.test_binding

One test in the customer's repository bound to one adopted expectation version.

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| repository_node_id | uuid | 004 |
| test_identifier | text | the runner's stable test identifier (007 R-10) |
| test_path | text | repository-relative |
| expectation_id | uuid | 005 |
| expectation_version_id | uuid | 005; must carry an active `anchor_grant` when the row becomes `active` (FR-007) |
| component_node_id | uuid | 004 |
| flow_node_id | uuid? | 004, for journey tests |
| rung | text | 007's rung vocabulary |
| origin | enum | `healer` · `human` — who wrote the test; both are bound the same way (R-06) |
| state | enum | `active` · `stale` · `quarantined` · `retired` |
| last_passed_commit | text? | on the default branch |
| observed_at | timestamptz | last `test_binding_ref` that confirmed it |
| state_changed_at | timestamptz | |

Unique `(tenant_id, repository_node_id, test_identifier)`. Rows are reconciled from
`test_binding_ref` shapes (R-06); a test no longer reported moves to `retired`, never deleted.

## regression.suite_run

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| repository_node_id | uuid | |
| trigger | enum | `pull_request` · `schedule` · `post_deploy` · `healer_delegated` |
| commit | text | |
| branch_kind | enum | `default` · `pull_request` |
| environment | text? | for `post_deploy` |
| ci_run_id | text | external identifier; idempotency key with `tenant_id` |
| selection_request_id | uuid? | for `pull_request` |
| state | enum | `observed` · `collecting` · `collected` · `collection_failed` |
| received_at | timestamptz | |

Test results are `test_result` evidence linked to the run by `evidence_link`, not stored here.

## regression.selection_request (append-only)

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| repository_node_id | uuid | |
| base_commit, head_commit | text | |
| changed_path_count | int | paths themselves are not retained |
| graph_version_id | uuid? | 004 version the closure used |
| selected_binding_ids | uuid[] | |
| full_suite | bool | |
| reason | text | `closure` · `unknown_path` · `closure_uncomputable` |
| created_at | timestamptz | |

## Not tables

- **Scenario** — an `ExpectedBehavior` (R-01).
- **Coverage** — computed at read time (R-09).
- **Draft batch** — a pull request; the cap counts draft expectations in open pull requests (R-02).
- **Test code** — lives in the customer's repository and never crosses.

## Cross-feature additions

Raised against the owning specifications, not implemented around them:

| Owner | Addition |
|-------|----------|
| 005 R-08 | optional `subject`, `given`, `when`, `then`, `priority` keys per `expected_behaviors` entry (R-01) |
| 012 runner protocol | `test_binding_ref` shape: test identifier, repository-relative path, expectation identifier, version — no test content (R-06) |
| 012 data model | `agent_run.agent_kind` gains `test_author` (R-07) |
| 001 | a normalisation ruleset version whose regression signature is binding identifier plus environment (R-08) |
| 002 | a test pull request is evaluated as the same action class as 008's pull request |

## Invariants

- No `test_binding` is `active` unless its expectation version has an active `anchor_grant`.
- No issue references a failing `test_result` from a `suite_run` with `branch_kind = pull_request`.
- A `quarantined` or `retired` binding's failures create no issues.
