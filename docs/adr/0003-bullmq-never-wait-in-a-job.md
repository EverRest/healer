# ADR 0003: BullMQ, and never wait inside a job

## Status

Accepted — 2026-09-23

## Context

The workflow spans 30–60 minutes with external waits: CI runs, deploys, canary observation. Temporal
fits that shape — durable workflows, timeouts, recovery, resumption. But it is a substantial
operational component, and adopting it early costs more than it returns.

The trap is *how* one defers it. If long waits are implemented as jobs that sleep or poll, durable
state, resumption, compensation and timeout handling get hand-rolled in Postgres — a worse Temporal
— and the eventual migration restructures every handler.

## Decision

BullMQ with Redis, plus one hard rule: **never wait inside a job.**

Every long wait is a persisted state plus an inbound callback — a CI webhook, a deploy webhook, a
scheduled verification tick. Jobs stay short and idempotent. The workflow lives in Postgres as an
explicit state machine, which is also the audit trail and the artifact a customer's
change-management process reviews.

## Consequences

- \+ No new operational component; Redis and Postgres are already required.
- \+ The state machine is inspectable, replayable and auditable — properties Temporal would have
  given us but which we need anyway for the product.
- \+ If Temporal later becomes justified, the migration is mechanical rather than a rewrite.
- − Callbacks must be idempotent and must tolerate arriving twice or never; timeout ticks are
  our responsibility.
- − Violating the rule once quietly reintroduces the trap, so it needs a lint or review check.
