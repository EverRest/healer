# Data Model: engineering foundation

Tables this feature owns. Domain tables belong to their own specs. All identifiers are UUID v7;
timestamps are `timestamptz` in UTC. Every tenant-scoped table carries `tenant_id` with an index
`(tenant_id, …)` ([prisma rules](../../.claude/rules/prisma-migrations.md)).

## Workflow execution

### workflow_run

The persisted state machine. Its transitions are the **machine-step** half of the audit trail and
timeline of 001 FR-013 — there is no second store *of them*, and none of them is copied into 001's
`issue_event`, which holds the domain facts (C-14).

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| issue_id | uuid | the subject (001) |
| definition_key | text | which workflow |
| definition_version | int | pinned at start; a redeploy does not migrate a running instance |
| state | text | current node in the machine |
| awaiting | jsonb? | what this run is waiting for — callback kind, token, deadline |
| correlation_id | uuid | threaded through every log, trace and job |
| started_at, updated_at | timestamptz | |
| deadline_at | timestamptz? | the state's own timeout, enforced by a scheduled tick |
| terminal_state | text? | set once; a terminal run never transitions again |

Index `(tenant_id, state)`, `(deadline_at) where terminal_state is null`.

### workflow_transition (append-only)

`id`, `run_id`, `from_state`, `to_state`, `cause` (`job` · `callback` · `timeout` · `human` ·
`policy`), `actor_ref`, `payload_digest`, `occurred_at`. Never updated, never deleted while the run
exists.

**The timeline boundary** (C-14): machine steps are rows here, domain facts are rows in 001's
`issue_event`. 001's `GetTimeline` unions the two. A job retry or a `timeout` transition is not a
domain fact, and a signal arriving is not a workflow transition — so neither table is total, nothing
is copied across, and a row that would belong to both is a sign the boundary was drawn wrong. A job
that exceeds its declared wall-clock is recorded here with cause `timeout` (FR-027); there is no
separate job-execution table.

### workflow_callback

The mechanism that makes "never wait inside a job" possible (ADR 0003).

`id`, `run_id`, `tenant_id`, `kind` (`ci_result` · `deploy_result` · `verification_tick` ·
`approval` · `runner_result`), `token_hash`, `expires_at`, `consumed_at?`, `received_count`.

Consuming a callback is idempotent: a second delivery with the same token increments
`received_count` and changes nothing else. A callback that never arrives is resolved by
`deadline_at` on the run, not by a waiting worker.

## Prompts

### prompt_version (immutable)

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| key | text | logical prompt name, e.g. `diagnosis.hypothesis` |
| digest | text | content hash; unique `(key, digest)` |
| body | text | the exact text |
| schema_ref | text? | expected structured-output schema |
| published_at | timestamptz | |
| published_by | text | |

No update path exists. Republishing identical content is a no-op; changed content is a new row.
Runtime resolves by `id`, never by `key` alone — resolving by name would make an old audit entry
point at new text.

## Tenant configuration

### tenant

`id`, `name`, `status` (`active` · `suspended` · `deleting`), `created_at`.

### tenant_provider_config

Per-tenant LLM access (ADR 0006, R-08).

| Field | Type | Rules |
|-------|------|-------|
| tenant_id | uuid | PK |
| mode | enum | `healer_provided` · `customer_byo` |
| provider | enum | `anthropic` · `openai` · `bedrock` · `vertex` |
| endpoint | text? | for BYO |
| credential_ref | text | reference into the secret manager — never the secret |
| fallback_scope | enum | `within_tenant_providers` only; cross-boundary fallback is not representable |
| model_tier_map | jsonb | `cheap` / `strong` / `frontier` → concrete model identifiers |

`fallback_scope` is an enum with one value on purpose: the dangerous configuration should not be
expressible, not merely defaulted away (R-08).

### tenant_budget

`tenant_id`, `period` (`day` · `month`), `spend_limit`, `time_limit`, `soft_threshold_pcts` int[],
`degradation_order` (ordered array), `updated_at`. Consumed by 002.

`soft_threshold_pcts` is an **array**, matching 002's `budget_limit.soft_threshold_pcts`: degradation
has ordered steps, and the per-tenant-period limits are inherited by 002 rather than converted, which
a scalar here would have made impossible.

## Runner

### runner_registration

| Field | Type | Rules |
|-------|------|-------|
| id | uuid | PK |
| tenant_id | uuid | |
| name | text | customer-chosen |
| protocol_version | int | declared at registration |
| capabilities | text[] | declared set (R-03) |
| image_version | text | |
| status | enum | `active` · `degraded` · `refused` · `revoked` |
| last_heartbeat_at | timestamptz | |
| refused_reason | text? | set when below the compatibility floor |

### runner_capability_resolution (append-only)

Why a given run behaved as it did: `run_id`, `runner_id`, `requested_capability`, `outcome`
(`available` · `degraded` · `refused`), `reason`, `occurred_at`. This is what makes a degraded
investigation explainable months later rather than merely noted.

## Self-observation

### agent_run

**The single store of the agent-run facts** (FR-033) — not a parallel telemetry table. Recorded here
because the registry, correlation and cost accounting live in this feature.

001's `audit_entry` stands alongside it and is not a second store (C-13). The key sets differ: that
table indexes **every** actor — human, system, runner, agent — while a row here is one agent
invocation. The model, prompt version, token, cost and tool fields 001 FR-012 requires exist only
here, and an `audit_entry` reaches them through `agent_run_id`.

`id`, `tenant_id`, `issue_id?`, `correlation_id`, `agent_kind` (`investigator` · `change` ·
`verifier` · `support` · `test_author` — 013 R-07), `prompt_version_id`, `model_id`, `provider`, `input_tokens`,
`output_tokens`, `cost`, `tool_calls` jsonb (name, argument digest, outcome — never raw arguments),
`policy_decision_id?`, `outcome`, `started_at`, `finished_at`, `executed_in` (`control_plane` ·
`runner`), `runner_instance_id?` — set when `executed_in = runner`, the row then written from an
`agent_run_report` (ADR 0010).

Tool call arguments are stored as digests, not values: arguments routinely contain file paths,
identifiers and excerpts, and this table is read by support.

## Not tables

Five Key Entities of [spec.md](spec.md) are deliberately not persisted here, because each would be a
second store of a fact that already exists (VIII):

- **RunnerRelease** — the published artifact is the record: an immutable image tag, its checksum in the
  registry, its entry in `docs/changelog.md` (FR-017). The supported protocol range is configuration;
  what a tenant runs is `runner_registration`.
- **JobExecution** — attempts, retries and dead letters live in BullMQ and are already observable; a
  wall-clock breach is a `workflow_transition` with cause `timeout` (FR-027).
- **PromptEvalResult** — owned by 011: a prompt version's eval history is the set of 011 run reports
  and metrics whose run configuration pins that `prompt_version_id` (FR-040).
- **CiGate** — the enumeration is [contracts/make-targets.md](contracts/make-targets.md) plus the
  machine-readable result each target emits (FR-016).
- **AgentTask** — the task line in `tasks.md` is the work item and its pull request is the record of
  execution (FR-053); agent identity is the VCS host's bot flag (R-13), not a table.

## Invariants

- A `workflow_run` in a non-terminal state has either a pending `workflow_callback` or a
  `deadline_at`. A run with neither is stuck by construction and is reported by a periodic check.
- No row in `prompt_version` is ever updated or deleted.
- Every `agent_run` resolves to an existing `prompt_version` and a recorded model identifier.
- `tenant_provider_config.mode = customer_byo` implies no `agent_run` for that tenant carries a
  Healer-provided `provider` value. Checked continuously, not only at call time.
- Every tenant-scoped table has `tenant_id`; a migration adding one without it fails the schema gate.
