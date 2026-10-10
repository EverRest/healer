# ADR 0018: Per-tenant sweeps are BullMQ job schedulers that fan out one idempotent job per tenant

## Status

Accepted — 2026-10-10. Implements C-90; touches no new dependency.

## Context

Four sweeps are built and tested and run nowhere: 001's staleness and retention sweeps, 012's
stale-runner sweep, 002's approval-expiry and revocation sweeps (plus `releaseAbandonedCharges` and
the two `check:*` reconcilers). Each is a per-tenant body; each deferred "nothing schedules this"
separately (C-90). Two pieces are missing and were about to be invented four times: **who lists the
tenants** and **what fires on a clock**.

## Decision

1. **Schedule = BullMQ job scheduler** (`Queue.upsertJobScheduler`, the successor of repeatable
   jobs), on the queue class the sweep already belongs to. Constitution VI names BullMQ; no cron
   daemon, no Kubernetes CronJob, no `node-cron`/`setInterval` (a timer inside a process is lost on
   restart and doubles with every replica). `upsertJobScheduler` is keyed by a deterministic id, so
   every worker boot re-registers the same schedule and Redis holds exactly one — restart and
   scale-out cannot double it.
2. **One closed list.** `TENANT_SWEEPS` in `@healer/workflow` is the only authority for which sweeps
   exist, on which queue, at what interval. Adding a sweep is one line there plus its per-tenant
   handler.
3. **Fan-out, never loop.** The scheduled job (`tenant-sweep-fanout`, data `{ sweep }`) does one
   thing: asks the `TenantEnumerator` for active tenant ids and enqueues one job per tenant
   (`name = sweep`, data `{ tenantId }`) with the deterministic `jobId`
   `<sweep>__<tenantId>__<fan-out job timestamp>`. A fan-out that dies halfway is retried by
   BullMQ with the same timestamp: already-enqueued tenants dedupe on `jobId`, the rest are added —
   no tenant is missed and none is swept twice by the retry. The fan-out never runs a sweep and
   never waits (ADR 0003).
4. **The enumerator is a control-plane port.** `TenantEnumerator.activeTenantIds()` is implemented
   in `apps/worker/src/infrastructure` against `tenant.tenant` (`status = active`). The fan-out takes
   tenant ids from this table only — never from a request or a caller-supplied list. Redis is a
   trusted control-plane store, as it already is for 001's sweeps: the per-tenant handler trusts the
   `tenantId` of any job on its queue (a UUID check in `TenantContext` is the only validation), so
   write access to the queue is write access to "sweep tenant X". No API route enqueues these jobs. `tenant.tenant` is the one table with no `tenant_id` column; reading it is
   the sanctioned cross-tenant read, and it returns ids and nothing else.
5. **Per-tenant jobs build their context from the enqueued `tenantId`**, via
   `TenantContext.forTrustedInternalUse`, exactly as 001's sweeps already do. A job for tenant A
   holds only A's id; every query inside the sweep body is scoped by it.
6. **Sweeps stay idempotent.** Delivery is at-least-once; the dedupe above is an optimisation, the
   guarantee is the sweep body (`expire` is a no-op on anything no longer pending).

## Rejected

- **A new dependency** (`node-cron`, `agenda`, Temporal): ADR 0003 and constitution VI.
- **One job that loops over all tenants:** a slow or failing tenant starves the rest, and one
  wall-clock budget has to cover the sum.
- **`setInterval` in the worker:** see 1.
- **Enumerating by `distinct tenant_id` over a feature table:** a tenant with nothing yet is
  invisible and each sweep would pick its own table.

## Consequences

- A suspended or deleting tenant is not swept. Anything that must still run for such a tenant
  (retention on a deleting tenant) needs its own decision; it does not get it by accident.
- Fan-out cost is O(tenants) sequential `add`s per tick under the `scheduling` queue's 15 s budget
  (a timed-out loop keeps running; `jobId` dedupe makes that safe, but the tick is dead-lettered).
  Switch to `addBulk` and keyset paging well before a thousand tenants.
- Operator question "is anything stuck" gains one more answer: `getJobSchedulers()` per queue.
