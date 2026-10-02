# ADR 0015: the budget charge takes a bounded, transaction-scoped advisory lock

## Status

Accepted — 2026-10-02

## Context

002's budgets are derived, never counted (R-10), and a step is charged **ex ante**: the policy engine
tests `consumed + declaredMax <= limit` and persists the allowed decision, whose declared maximum
then counts as an *open charge* until the step's `agent_run` lands with its actual cost (R-11).
Under READ COMMITTED that read-then-write is unsafe on its own: two concurrent steps both read
`consumed = 90`, both pass `90 + 10 <= 100`, and both commit. Reproduced: 17 of 20 concurrent
charges against a limit of 10 were allowed without serialisation.

ADR 0003 forbids waiting inside a job, and 008 R-16 rejected a Postgres advisory lock for repository
mutations on exactly that ground — a lock held across a worker's multi-minute apply is a wait inside
a job, and a `repo_mutation_lease` row is the right shape there. This ADR records why the budget
charge is a different case, and bounds it so that it stays one.

## Decision

`EvaluateAndBind` for a step that declares a cost resolves the budget and persists the decision
inside **one database transaction** that first takes `pg_advisory_xact_lock(hashtextextended(
'policy.budget:' || tenantId, 0))`.

- **Held for a transaction, not for work.** The lock is released at commit or rollback. Nothing the
  step *does* — the model call, the tool calls, the wait for a callback — happens under it; by then
  the charge is a committed row (the open charge), which is the persisted state ADR 0003 asks for.
  The hold time is the aggregate plus one insert.
- **The wait is bounded.** `lock_timeout` is set to `BUDGET_LOCK_WAIT_MS` (5 s) for the acquisition
  only. Past it the call fails with `BudgetContentionError` (HTTP 429, retryable) and the job
  retries through BullMQ, instead of parking a pooled connection behind every charge ahead of it.
  The transaction as a whole is bounded too (`maxWait` 10 s, `timeout` 30 s).
- **Per tenant.** One key per tenant covers the tenant's day and month and every issue under it, so
  there is exactly one thing to take. A tenant's charges serialise; tenants do not contend.
- **Only a charge takes it.** A step that declares no cost charges nothing and reads without the
  lock; a dry run never takes it.
- **An advisory lock, not a row lock**, because no row is guaranteed to exist to lock: a tenant that
  never configured a budget runs on the fail-closed defaults and has no `budget_limit` row, and the
  policy tables carry no foreign key to `tenant`.
- **Idempotent.** The decision carries a `request_key`; under the lock a retry of the same
  `(tenant, run, state, request)` returns the live allowed decision already minted, so a retry after
  a lost response does not charge twice. A partial unique index backs it.
- **Released charges are a command, not a timer.** An allowed step that never starts would hold its
  charge forever; `releaseAbandonedCharges` invalidates those older than a TTL
  (`invalidated_reason = 'charge_abandoned'`). No production caller schedules it yet.

## Alternatives considered

- **A lease row held across the step (008 R-16's shape).** Correct for repository mutations, where
  the thing guarded is the long-running apply. Here the guarded thing is a read-modify-write of
  milliseconds; a lease adds a table, an expiry and the leak every lease has when a worker dies, to
  guard something a transaction guards.
- **SERIALIZABLE isolation.** Turns every contended charge into a `40001` the caller must retry, with
  no bound on how many, and still needs the same aggregate to be correct. A bounded lock is simpler
  to reason about and to observe (`pg_stat_activity` shows the waiter).
- **A counter row updated with `UPDATE … SET consumed = consumed + x WHERE consumed + x <= limit`.**
  Atomic and cheap — and a stored counter, the second number R-10 exists to prevent.
- **`FOR UPDATE` on a `budget_limit` row.** No row guaranteed (above).

## Consequences

- \+ The ex-ante guarantee holds under concurrency: a 400-issue flood allowed exactly the charges
  that fit and recorded the degradation steps once each (`budget-flood.e2e.test.ts`).
- \+ A held lock is visible and a stuck one is bounded: the waiter fails retryably in 5 s.
- − A tenant's charges serialise; throughput is one charge per transaction. At the sizes in R-10
  (10 000 runs a tenant-month) that is not the constraint; if it ever is, the unit to shard is the
  scope, not the lock.
- − A step's retry must be safe to repeat: it is, by the request key. A caller that *wants* a fresh
  charge for the same step must invalidate the old decision first.
- − The lock is a pattern this repository did not have; a second use of it needs its own paragraph
  here, not a copy.
