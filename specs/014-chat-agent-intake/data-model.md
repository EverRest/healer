# Data model: chat intake for agent work

Schema `intake`. Four tables, all tenant-scoped, every index led by `tenant_id`
(`.claude/rules/prisma-migrations.md`). Not persisted, by the spec's own list: the agent's prompt
text and the model's input and output, raw pasted logs beyond ingestion's redacted excerpt, and the
allowlist (configuration).

**Migration** (designed here, not written): `prisma/migrations/20261009000000_014_intake_core/`
with `migration.sql` and `down.sql`. `20261008000000` is the latest prefix on every ref as of
2026-10-11; re-check `ls prisma/migrations` and `git fetch` before writing it. `down.sql` drops the
four tables, their enums and the `intake` schema, in reverse order; the schema is new, so down-then-up
loses only intake rows and nothing else. `schema.prisma`'s datasource `schemas` list gains `"intake"`.

## `intake.work_item`

One request from the channel — the unit the owner sees.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `tenant_id` | uuid NOT NULL | from intake configuration (FR-008) |
| `channel_key` | text NOT NULL | the configured channel the post came from; reports go back there (FR-024) |
| `kind` | `intake.work_item_kind` | `investigate` · `fix` · `task` · `finding` |
| `state` | `intake.work_item_state` | graph below |
| `reason_code` | text NULL | a member of [contracts/reason-codes.md](contracts/reason-codes.md); NOT NULL iff `state` ∈ {`failed`, `stopped`, `cancelled`, `expired`} (CHECK) |
| `policy_reason_code` | text NULL | 002's own reason code when `reason_code = policy_denied` — referenced, not restated |
| `requester_ref` | text NOT NULL | `<platform>:<user id>`, e.g. `telegram:123456789`; the audit actor (FR-023) |
| `description` | text NOT NULL | the post's argument as data, ≤ 4000 characters (FR-002) |
| `task_ref` | text NULL | `T\d{3,4}`, kind `task` only (CHECK) |
| `ledger_ref` | text NULL | `<ledger>:<id>`, e.g. `github:issue:123`; NOT NULL for `fix`, `task` and `finding` once created (FR-022) |
| `parent_id` | uuid NULL | the investigation a "widen" or "open issue" button started from |
| `content_hash` | char(64) NOT NULL | SHA-256 of the canonical card content (kind, description, `task_ref`, `ledger_ref`, grant, spend cap) |
| `version` | integer NOT NULL DEFAULT 1 | incremented by every transition; renders trail it (research R-10) |
| `created_at`, `updated_at` | timestamptz | |
| `terminal_at` | timestamptz NULL | set once, with a terminal state (CHECK) |

Constraints and indexes:

- `UNIQUE (tenant_id, id)` — target of the composite foreign keys below (012 FR-048 pattern).
- `UNIQUE (tenant_id, task_ref) WHERE terminal_at IS NULL` — a task already in flight is refused
  (`task_in_flight`).
- `UNIQUE (tenant_id, ledger_ref) WHERE terminal_at IS NULL AND kind IN ('fix','task')` — a second
  `/fix` on the same issue is refused (`work_item_busy`).
- `INDEX (tenant_id, state)`, `INDEX (tenant_id, created_at)` — `/status` and the sweep.

### State graph — this table is the authority; the code mirrors it

`packages/domain/intake/src/domain/state-machine.ts` declares exactly these edges, with a test that
reads this table (the 001 `issues` state-machine precedent).

| From | To |
|------|----|
| `awaiting_confirmation` | `confirmed` · `cancelled` · `expired` |
| `confirmed` | `running` · `failed` · `cancelled` |
| `running` | `reported` · `stopped` · `cancelled` · `failed` |
| `reported` · `stopped` · `cancelled` · `expired` · `failed` | — (terminal) |

- Initial states: `investigate` is created in `confirmed` (FR-009, FR-021); `fix` and `task` in
  `awaiting_confirmation`; `finding` directly in `reported` — it is recorded, ingested (FR-003) and
  acknowledged, and has no job to run. The domain refuses to build a directive for kind `finding`;
  the "investigate" button on it creates a new `investigate` item with `parent_id` (US5 AS2).
- `confirmed → failed` carries `policy_denied`, `concurrency_cap` or `dispatch_failed`;
  `running → failed` carries `timeout`, `run_cancelled_on_host` or `report_invalid`;
  `running → stopped` carries `budget_exhausted`; `* → cancelled` carries `cancelled_by_owner`.
- Stage 3's follow-up loop (`needs-decision` answered in the channel) adds an edge out of `reported`
  in the change that builds it; it is not declared ahead of its consumer.
- Every transition writes one `audit.audit_entry` in the same transaction (actor `human` with the
  requester for owner actions, `system` for the sweep, `agent` for host events), with `action` a
  registered `policy_action` key (list below).

## `intake.work_job`

One execution attempt of a work item. Idempotency key `(tenant_id, work_item_id, attempt)`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | appears in the callback path |
| `tenant_id` | uuid NOT NULL | |
| `work_item_id` | uuid NOT NULL | FK `(tenant_id, work_item_id)` → `work_item (tenant_id, id)`, RESTRICT |
| `attempt` | integer NOT NULL | 1-based |
| `executor` | text NOT NULL | adapter name from the executor contract's registry (`github_actions`, `fake`) |
| `grant` | `intake.job_grant` | `read_only` · `branch_and_pull_request` |
| `policy_decision_id` | uuid NOT NULL | the `allow` that dispatched it; no FK into `policy` (012 does not FK into 002 — same choice as `workflow_callback.approval_id`) |
| `host_repository_id` | text NOT NULL | bound at dispatch |
| `host_workflow_ref` | text NOT NULL | the workflow the grant names (research R-06) |
| `host_run_id` | text NULL | bound at dispatch or by the first `started` (research R-04); never rebound |
| `host_run_attempt` | integer NULL | bound with `host_run_id` |
| `dispatched_at` | timestamptz NOT NULL | |
| `deadline_at` | timestamptz NOT NULL | dispatch + wall-clock + grace (research R-12) |
| `last_event_seq` | integer NOT NULL DEFAULT 0 | an event with `seq ≤ last_event_seq` is a duplicate (FR-018) |
| `current_step` | text NULL | a member of the executor contract's step list |
| `outcome` | `intake.job_outcome` NULL | set once with `ended_at` |
| `result_ref` | text NULL | pull request, draft or branch reference |
| `report_digest` | char(64) NULL | SHA-256 of the validated `ended` payload |
| `findings_withheld` | integer NULL | uncited or unresolvable findings dropped (research R-10) |
| `agent_run_id` | uuid NULL | the `agent_run` row holding the reported cost (research R-09, pending U-02) |
| `reason_code` | text NULL | as on `work_item` |
| `ended_at` | timestamptz NULL | |

Constraints and indexes:

- `UNIQUE (tenant_id, work_item_id, attempt)`.
- `UNIQUE (tenant_id, work_item_id) WHERE ended_at IS NULL` — one job per work item at a time
  (FR-015), held by Postgres rather than by a read-then-write.
- CHECK: `grant = 'read_only'` ⇒ `outcome IS NULL OR outcome IN ('found','not_found','inconclusive')`;
  `grant = 'branch_and_pull_request'` ⇒ `outcome IS NULL OR outcome IN ('pull_request','needs_decision','stopped')`.
  An investigation that ends in a pull request is not representable (SC-006).
- CHECK: `ended_at IS NOT NULL OR (outcome IS NULL AND reason_code IS NULL)`, and
  `ended_at IS NULL OR outcome IS NOT NULL OR reason_code IS NOT NULL` — an ended job says how it
  ended; a running one says neither.
- `UNIQUE (tenant_id, host_run_id) WHERE host_run_id IS NOT NULL` — one run binds one job.
- `INDEX (tenant_id, deadline_at) WHERE ended_at IS NULL` — the sweep (research R-05).

Event application is one guarded update: `… SET last_event_seq = :seq, … WHERE tenant_id = :t AND id =
:job AND last_event_seq < :seq AND ended_at IS NULL`, inside the transaction that also transitions
the work item; zero rows is a duplicate or a stale event. Concurrency tests hold one transaction open
and prove the second waits on the row lock (`prisma-concurrency.ts` pattern), never by sleeping.

## `intake.chat_message_ref`

The channel message of a card and of a report, so both can be edited in place.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `tenant_id` | uuid NOT NULL | |
| `work_item_id` | uuid NOT NULL | FK `(tenant_id, work_item_id)` → `work_item`, RESTRICT |
| `purpose` | `intake.message_purpose` | `card` · `report` |
| `channel_key` | text NOT NULL | |
| `chat_id` | text NOT NULL | platform identifiers as text (Telegram ids exceed 2^31) |
| `message_id` | text NULL | null until the first send succeeds |
| `rendered_version` | integer NOT NULL DEFAULT 0 | trails `work_item.version` |
| `rendered_digest` | char(64) NULL | of the last text sent; an equal render is skipped |
| `last_failure` | text NULL | a reason code (`channel_unavailable`, `report_withheld_secret`) |
| `card_token_hash` | char(64) NULL | SHA-256 of the opaque card id in the buttons (stored hashed, as 012's callback registry does) |
| `card_owner_ref` | text NULL | the only account that may confirm |
| `card_content_hash` | char(64) NULL | the `work_item.content_hash` shown on the card |
| `card_expires_at` | timestamptz NULL | |
| `card_used_at` | timestamptz NULL | set once; a second confirmation finds it set (FR-010) |

Constraints and indexes: `UNIQUE (tenant_id, work_item_id, purpose)`; `UNIQUE (card_token_hash)`
where not null; CHECK that the five `card_*` columns are all set iff `purpose = 'card'`;
`INDEX (tenant_id, work_item_id)`.

## `intake.chat_update_seen`

A platform update already processed (FR-007).

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | the audit `target_id` for a refusal that has no work item |
| `tenant_id` | uuid NOT NULL | |
| `channel_key` | text NOT NULL | |
| `update_id` | bigint NOT NULL | |
| `disposition` | `intake.update_disposition` | `work_item` · `button` · `refused` · `ignored` · `unclassified` · `finding` |
| `received_at` | timestamptz NOT NULL DEFAULT now() | |

`UNIQUE (tenant_id, channel_key, update_id)`; `INDEX (tenant_id, received_at)`. Retention is not
designed here: Telegram keeps an undelivered update for at most 24 hours, so a later sweep may prune
rows older than a few days; nothing reads them past that.

## Enums

Each Postgres enum below is the storage of a closed list whose authority is named; the domain
package mirrors it as a string union with a test pinned to the Prisma enum (the `issue-enums.ts`
convention).

| Enum | Members | Authority |
|------|---------|-----------|
| `work_item_kind` | `investigate` `fix` `task` `finding` | spec Key Entities |
| `work_item_state` | the eight states above | the state graph above |
| `job_grant` | `read_only` `branch_and_pull_request` | FR-013 |
| `job_outcome` | `found` `not_found` `inconclusive` `pull_request` `needs_decision` `stopped` | FR-026, FR-027 |
| `message_purpose` | `card` `report` | this document |
| `update_disposition` | listed above | this document |

Reason codes are **not** a Postgres enum: [contracts/reason-codes.md](contracts/reason-codes.md) is
their one authority and adding a code must not need a migration; the column is validated by the
domain on write.

## Registrations in other owners' lists (one line each, in the change that needs it)

- 002 `SEED_POLICY_ACTIONS`: `intake.dispatch_investigation`, `intake.dispatch_change`, and the
  audit-only, `mutating: false` keys `intake.create_work_item`, `intake.refuse`,
  `intake.confirm_card`, `intake.cancel`, `intake.job_event` — `audit_entry.action` must be a
  registered key (001 schema comment). Owning spec `014`.
- 012 `TENANT_SWEEPS`: `intake-deadlines` (research R-05).
- 012 `agent_run.executed_in`: `external_host` — pending U-02, research R-09.

## Relationships

```text
work_item 1 ── * work_job ── 0..1 agent.agent_run        (cost, pending U-02)
work_item 1 ── 0..2 chat_message_ref (card, report)
work_item * ── 0..1 work_item (parent_id)
work_item ── audit.audit_entry (target_type 'work_item')
chat_update_seen ── audit.audit_entry (target_type 'chat_update', refusals with no work item)
work_job.policy_decision_id ── policy.policy_decision    (no FK)
```
