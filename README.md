# Healer

Turns an issue — a production incident, a user report, an alert or a regression — into a diagnosis
backed by evidence, and where policy permits, into a verified change.

**The centre of this architecture is not the LLM.** The centre is Evidence + Domain State + Policy
+ Verification. The model proposes; evidence, policy and verification decide.

> Quality comes from the loop, not from the model.

## Status

Specifications complete for all thirteen features: 399 functional requirements, 148 success
criteria, ~1221 tasks, all clarifications resolved. **Implementation (VERSION 0.37.0):**

- **012 engineering-foundation — 67/96 tasks.** Monorepo, tenancy as a compile-time guarantee, the
  workflow machine, the full gate suite (`make ci`), boundary lint rules, the runner protocol's
  schemas, the transactional outbox, prompt registry, self-observation.
- **001 issue-and-evidence — 26/57 tasks. Phases 1–3 complete** (Foundational + US1 dedup/ingest):
  append-only evidence, the issue state machine, fingerprint normalisation, `POST
  /ingest/signals`, idempotent delivery, reopen/recurrence, the real BullMQ consumer, a load check
  that found and fixed a real concurrency bug (a burst of a brand-new fingerprint used to
  fragment into several issues instead of one).
- **002–011, 013 — not started.** Dependency order: 012 → 001 → 002 → 003 → 004 → 005 → 006 → 011
  → 009 → 010 → 007 → 008 → 013.

See [docs/roadmap.md](docs/roadmap.md) for exact phase state, [docs/changelog.md](docs/changelog.md)
for what landed and why, and [docs/stage-0.md](docs/stage-0.md) for what still blocks realistic
sizing of v1.

## Running it locally

```bash
make bootstrap      # install, start Postgres + Redis, migrate, seed — one command, no manual step
make ci             # the full gate set: secret-scan, lint, typecheck, build, tests, contract drift
```

Focused targets for iteration: `make lint`, `make typecheck`, `make test-unit`, `make test-e2e`
(needs Docker), `make db-check`. `make help` lists every target.

`test-e2e` boots real, disposable Postgres and Redis containers per test file (testcontainers) —
no mocked database or queue anywhere in the suite. `apps/api/load.e2e.test.ts` is the one load
test today: it boots the real HTTP server and the real `apps/worker` consumer together and proves
signal ingestion doesn't lose or fragment issues under sustained concurrent load.

## What v1 is

```text
Issue → Context → Evidence → Diagnosis          all sources, one pipeline
      → Reproduction → TDD fix → Pull request   human always merges (L2 ceiling)
      → AutoSupport proposal                    Healer never sends
      → Regression suite                        adopted expectations → tests → CI → issues
      → Safe remediation                        reversible actions, autonomous rollback
```

Autonomy is granted per tenant, per component, per environment, per action — never globally.
The year-one ceiling is L2: Healer opens pull requests, humans merge them.

Client-side reproduction (007/008) uses Playwright when a symptom is only observable in a
browser — that is a **product capability** for reproducing a customer's client-side issue, not a
test-suite tool. See [decisions.md](docs/decisions.md) C-24..C-28.

## Deployment

Hybrid. The control plane (issues, evidence, policy, agents, knowledge, dashboard) is ours.
The execution plane (repository checkout, sandbox, tests, code intelligence, log collection and
redaction, remediation) runs in the customer's infrastructure. What crosses the boundary is
structured evidence, never raw logs.

**Open gap, not yet specified or built**: where and how Healer's *own* control plane actually gets
deployed to a real, running environment (staging/production hosting, a release workflow beyond
`.github/workflows/ci.yml`'s `make ci` on push/PR, post-deploy smoke checks, automatic rollback on
a failed health check). 012 FR-052 only says v1 *must not* need Kubernetes or Terraform — it names
no positive target. There is also no automated browser-level smoke or regression suite exercising
a *running* Healer deployment (Playwright's only use today is the product capability above, not a
check against our own environments). Flagged in `QUESTIONS.md` for whoever picks a hosting target
and a release process — this is new-infrastructure territory (an ADR, per this repo's own rule),
not something to invent silently.

## Reading order

| Document | Why |
|----------|-----|
| [.specify/memory/constitution.md](.specify/memory/constitution.md) | Principles. I, II and IV block merge if violated |
| [docs/decisions.md](docs/decisions.md) | What was decided and why, with rejected options |
| [docs/roadmap.md](docs/roadmap.md) | Specs, dependency order, v1 shape, exact phase state |
| [docs/changelog.md](docs/changelog.md) | What landed, in what order, and why — the detailed build log |
| [docs/stage-0.md](docs/stage-0.md) | Blockers and deliberately-unset values — S0-1 sizes the whole product |
| [QUESTIONS.md](QUESTIONS.md) | Open judgment calls and known gaps flagged for review, not yet resolved |
| [research/wiki/index.md](research/wiki/index.md) | Product thesis, incident taxonomy, failure modes, agent-driven development |
| [AGENTS.md](AGENTS.md) | Rules for AI agents working on this repository |

## Stack

TypeScript · NestJS monorepo · PostgreSQL (+pgvector) · Redis/BullMQ · Docker sandbox.
See the constitution's technology table for the full list and the reasoning.

## Building Healer with agents

Healer's own repository is built largely by coding agents against the task lists in `specs/`
(012 US10, [ADR 0011](docs/adr/0011-agent-driven-development.md)). What actually constrains an
agent — repository-host bot identity, protected paths, a gate that catches a weakened test, a
merge ruleset the agent cannot bypass — is documented in
[research/wiki/agent-driven-development.md](research/wiki/agent-driven-development.md), not left
to prompt text. Thirteen ADRs record every new dependency or pattern decision so far
([docs/adr/](docs/adr/)).
