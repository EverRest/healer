# Implementation Plan: Chat intake for agent work

**Branch**: `014-chat-agent-intake` · **Spec**: [spec.md](spec.md) · **Date**: 2026-10-11

## Summary

The owner posts `/investigate`, `/fix` or `/task` in the project's chat; an agent picks the request
up and one message in the same chat edits itself to the outcome. A new domain package,
`@healer/domain-intake`, classifies posts by structure, holds a closed work-item state machine in a
new `intake` schema, and talks to three ports — a chat channel (Telegram first), an agent executor
(GitHub Actions with the Claude Code action first) and a work ledger (GitHub Issues). Two HTTP routes
carry everything in: the platform's webhook, authenticated by its shared secret, and the executor's
callback, authenticated by the host's OIDC identity token bound to the repository and run. Nothing
waits: dispatch is a short job, status arrives by callback, and a C-90 tenant sweep times out what
never reports.

Two ideas shape it. **The grant is the token, not the prompt**: an investigation is a different
workflow whose token cannot write, so "read-only" is a host refusal rather than an instruction
(research R-06). **The database is the state, the channel is a view**: every transition commits
first, renders after, and a render that fails is repaired by the sweep (research R-05, R-10).

## Technical Context

**Language/Version**: TypeScript 5.x, Node 22 LTS — as 012

**Primary Dependencies**: no new dependency in stage 1's domain and adapters (`fetch` for the Bot
API and the GitHub REST API). One proposed: a JWT/OIDC library for the callback verifier and the
dispatcher App's JWT — [ADR 0019](../../docs/adr/0019-oidc-identity-token-verification.md),
Proposed; not added by this plan. Reused: `@healer/workflow` (queues, `TENANT_SWEEPS`),
`@healer/domain-policy` (`evaluateAndBind`, wired by the apps), `@healer/events` conventions,
`prisma-concurrency.ts`, `test/tenant-isolation.ts`

**Storage**: PostgreSQL, new schema `intake` — four tables ([data-model.md](data-model.md));
migration `20261009000000_014_intake_core` designed, not written

**Testing**: Vitest unit and e2e with Testcontainers (012 R-12); race tests hold a transaction open
and observe the lock, never sleep; two contract suites (channel, executor) run against every adapter;
`make intake-smoke` for the whole path

**Target Platform**: control plane (`apps/api` routes, `apps/worker` jobs and sweep); GitHub Actions
in Healer's own repository as the first execution host

**Project Type**: a domain module plus adapters in the existing monorepo

**Performance Goals**: the webhook answers within the platform's delivery timeout with database work
only (no outbound call in the request); a terminal report is visible within 60 s of `ended` in the
smoke run (SC-007, research R-12)

**Constraints**: no tenant from a request (FR-008); no raw log body, source or secret in a report,
directive, log or evidence record (FR-025, FR-031); no wait inside a job (ADR 0003); one job per work
item, held by a partial unique index (FR-015); reason codes from one authority (FR-028)

**Scale/Scope**: one tenant (Healer), one project, one owner in stage 1; tens of work items a day

## Constitution Check

*GATE: checked before Phase 0, re-checked after Phase 1 (below).*

| Principle | How this feature satisfies it | Status |
|-----------|-------------------------------|--------|
| I. Evidence First | Every finding in an investigation report cites a reference of a closed kind, each resolved for existence before display; uncited findings are dropped (FR-026, research R-10). The report is a draft for the owner, not an `Evidence` record or a diagnosis — see Complexity Tracking | ⚠ justified |
| II. Anti-Circular Verification | The report is never an anchor: it does not become `ExpectedBehavior`, evidence or a test assertion. Change work is judged by ADR 0011's existing gates (red-first against the base revision, protected tests), not by the agent's own report | ✅ |
| III. Reproduce Before Modify | Change jobs run under ADR 0011: `gate-red-first` requires a test failing on the base revision. Findings are never dispatched; they enter 001's classify-first path (FR-003). `inconclusive` is a complete outcome (FR-026) | ✅ |
| IV. Deterministic Control | Classification reads structure only (R-15); every dispatch passes 002 with a persisted decision (FR-012) — with the input-shape gap of R-08 recorded as blocking; transitions are idempotent guarded updates; budgets and timeouts are host-enforced stops | ✅ (R-08 open) |
| V. Dependency-Aware Change | No change scope decided here; change jobs inherit ADR 0011's protected paths and gates | n/a |
| VI. Serialize / Parallelize | Dispatch is a short job; status is an inbound callback; stuck jobs are a C-90 sweep (R-04, R-05). No new queue class | ✅ |
| VII. Architecture Agnostic | Ports name no product; Telegram, GitHub and later Slack live under `packages/integrations` (FR-020) | ✅ |
| VIII. Simplicity | No SDKs (`fetch`); one schema, four tables; one sweep; one dependency proposed behind an ADR | ✅ |

**Security model**: the post is data (FR-002, SC-002); the read-only and change grants are different
workflows with different tokens, and the control plane never holds the change App's key (R-06); the
callback credential is minted by the host per run and bound to it (R-04); the bot token, webhook
secret and dispatcher key are secrets read through `shared/config` only, with 012 T066 recorded as
debt (R-11). The GitHub-hosted runner is not Healer's sandbox: it works on Healer's own repository
under ADR 0011 and holds no production credential; the product sandbox rules of 007 are not relaxed.

**Post-design re-check (after Phase 1)**: unchanged. The data model makes three unsafe states
unrepresentable instead of checked — two running jobs for one work item (partial unique index), an
investigation job ending in a pull request (CHECK over grant and outcome), a run bound to two jobs
(unique `host_run_id`). Two items stay open and are carried as blockers, not assumptions: 002's input
shape for a dispatch without a 001 issue (U-01) and where the job's cost lands (U-02).

## Project Structure

### Documentation (this feature)

```text
specs/014-chat-agent-intake/
├── plan.md · research.md · data-model.md · quickstart.md · tasks.md (next: /speckit-tasks)
└── contracts/
    ├── channel-port.md      # ChatChannel port, webhook route, channel contract suite
    ├── executor-port.md     # AgentExecutor port, directive, signed callback, steps, executor suite
    ├── work-ledger-port.md  # WorkLedger port (GitHub Issues first)
    ├── command-grammar.md   # classification order, commands, buttons
    └── reason-codes.md      # the one authority for FR-028
```

### Source Code (repository root)

```text
packages/domain/intake/              # @healer/domain-intake — new (amends 012 FR-001)
├── src/domain/                      # classify, state-machine, card, render, reason-codes,
│                                    #   chat-channel / agent-executor / work-ledger ports,
│                                    #   dispatch-policy and signal-intake ports
├── src/application/commands/        # handle-update, confirm-card, dispatch-job, apply-job-event,
│                                    #   render-message, sweep-deadlines, cancel
└── src/infrastructure/              # Prisma repositories, record-intake-audit-entry
packages/integrations/src/telegram/  # ChatChannel adapter (fetch, Bot API)
packages/integrations/src/github/    # AgentExecutor, CallbackVerifier, WorkLedger adapters
packages/workflow/src/schedule/      # TENANT_SWEEPS gains 'intake-deadlines'
packages/shared/src/config/          # intake channel configuration and secrets (presence-only)
apps/api/src/intake/                 # webhook and callback controllers (thin), port wiring
apps/worker/src/                     # dispatch, render, cancel processors; the sweep body
prisma/migrations/20261009000000_014_intake_core/   # migration.sql + down.sql
.github/workflows/agent-investigate.yml             # read-only workflow (new, protected path)
.github/workflows/agent-task.yml                    # change workflow (012 T089)
```

**Structure decision**: the domain package owns the rules and the ports; adapters own every product
fact; the apps own wiring, HTTP and queues. Cross-domain calls (002 policy, 001 ingestion) go through
ports the apps wire, so no domain package imports another (research R-03).

## Phase 0 — research

See [research.md](research.md): why GitHub Actions first (R-01), why a GitHub Issue is the ledger
(R-02), why an `intake` package (R-03), the callback without a wait and its identity binding (R-04),
the C-90 sweep (R-05), separate grants (R-06), Telegram's facts (R-07), policy for a dispatch with
no 001 issue (R-08), where cost lands (R-09), reports (R-10), the secret debt (R-11), starting values
(R-12), tenant resolution and isolation tests (R-13), the smoke target (R-14), classification (R-15),
and the Unresolved list U-01..U-08.

## Phase 1 — design

- [data-model.md](data-model.md) — `work_item` (state graph authority), `work_job`,
  `chat_message_ref`, `chat_update_seen`; registrations in 002 and 012's lists.
- [contracts/](contracts/) — the five documents above.
- [quickstart.md](quickstart.md) — one scenario per acceptance scenario, and `make intake-smoke`'s
  contract (declared in 012 [contracts/make-targets.md](../012-engineering-foundation/contracts/make-targets.md)).

## Stages (from the spec) mapped to what blocks them

| Stage | Blocked by |
|-------|-----------|
| 0 | Pavlo: GitHub Apps (U-03), ruleset (012 T088–T092), bot token, owner id, group not channel (U-05), public address |
| 1 | U-01, U-02, U-04, U-08 |
| 2 | stage 1, 012 T089 and T097, U-07 |
| 3 | stage 2; 012 T100's answer; mapping a pasted post onto 001's `Signal` (component and environment are required there and a paste carries neither — decided in stage 3) |
| 4 | 006–008 and the GitHub VCS adapter (012 T101) |

## Spec inconsistencies found while planning (spec.md not edited)

1. **C-96 and C-97 did not exist** in `docs/decisions.md` though spec.md cites them. Added there as
   **Proposed**, worded from the spec's clarifications.
2. **"An issue of kind `finding`"** (FR-003, US5): 001's `IssueKind` has no `finding`. Read as: the
   work item's kind is `finding`, its ledger issue is labelled `finding`, and the 001 issue the
   signal creates keeps 001's own kind. Glossary updated to say so.
3. **FR-026 vs SC-008**: FR-026 and US1 AS3 drop an uncited finding ("is not shown"); SC-008 says a
   report with one "is rejected". Planned as FR-026 (drop and count); SC-008 holds for what is shown.
4. **US2's summary** ("the owner sees that they were refused") **vs AS1** ("nothing is replied"):
   planned as AS1 — audit only, no reply; the owner sees refusals in the audit trail.
5. **012 FR-053 / T088** require an agent pull request to name a `tasks.md` identifier present on
   the base revision; `/fix` and `/task <text>` have only a GitHub Issue (FR-022), so 012's gate
   would refuse their pull requests. `/task T0xx` is unaffected. Needs 012's text amended (U-07).
6. **012 spec "deliberately not persisted: ChatPost / ChatTask"** vs 014's `work_item` table —
   research R-02 records the reading taken (U-07).
7. **FR-021's arrow chain** reads linear; the planned graph (data-model.md) has `cancelled`,
   `expired` and `failed` reachable from earlier states, and `finding` created directly in
   `reported`.
8. **US4 AS4** "refused, audited": a token with a bad signature names no tenant, so it is logged and
   counted, not written to `audit_entry`; a valid token for the wrong run is audited.
9. **FR-012** places the concurrency cap inside the Policy Engine; 002 has no such predicate today
   (R-08, U-01).

## Complexity Tracking

| Deviation | Why | Simpler alternative rejected because |
|-----------|-----|--------------------------------------|
| Investigation findings shown with existence-checked references rather than as 001 `Evidence` records (Principle I) | The MVP report is a draft for the owner about Healer's own repository; it is never a diagnosis, never an anchor, and makes no claim the product acts on. Each reference is resolved before display and an unresolvable one counts as no reference | Writing each finding as an `Evidence` record needs an issue to hang it on (001) — that is stage 4, when the product pipeline is the executor. Showing uncited prose would be worse; showing nothing would remove the feature |
| A new domain package | 014 is a spec; `packages/domain/*` is one package per spec | Folding into `issues` or `workflow` gives either package a second owner |
| A JWT library (proposed) | The host's identity token is the only callback credential the run cannot forge and Healer never stores | A shared HMAC secret is readable by every workflow, the read-only one included; hand-rolled verification puts algorithm pinning and key rotation in our code (ADR 0019) |
