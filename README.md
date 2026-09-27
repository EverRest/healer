# Healer

Turns an issue — a production incident, a user report, an alert or a regression — into a diagnosis
backed by evidence, and where policy permits, into a verified change.

**The centre of this architecture is not the LLM.** The centre is Evidence + Domain State + Policy
+ Verification. The model proposes; evidence, policy and verification decide.

> Quality comes from the loop, not from the model.

## Status

Specifications complete for all thirteen features. **Implementation has started**: 012
(engineering foundation) phases 1–7 of 13 — the monorepo, tenancy as a compile-time guarantee, the
workflow machine, the gate suite (`make ci`), boundary lint rules, the runner protocol's schemas
and handshake logic, never-wait-in-a-job. See [docs/roadmap.md](docs/roadmap.md) for exact phase
state and [docs/stage-0.md](docs/stage-0.md) for what still blocks realistic sizing of v1.

## Running it locally

```bash
make bootstrap      # install, start Postgres + Redis, migrate, seed — one command, no manual step
make ci             # the full gate set: secret-scan, lint, typecheck, build, tests, contract drift
```

Focused targets for iteration: `make lint`, `make typecheck`, `make test-unit`, `make test-e2e`
(needs Docker), `make db-check`. `make help` lists every target.

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

## Deployment

Hybrid. The control plane (issues, evidence, policy, agents, knowledge, dashboard) is ours.
The execution plane (repository checkout, sandbox, tests, code intelligence, log collection and
redaction, remediation) runs in the customer's infrastructure. What crosses the boundary is
structured evidence, never raw logs.

## Reading order

| Document | Why |
|----------|-----|
| [.specify/memory/constitution.md](.specify/memory/constitution.md) | Principles. I, II and IV block merge if violated |
| [docs/decisions.md](docs/decisions.md) | What was decided and why, with rejected options |
| [docs/roadmap.md](docs/roadmap.md) | Specs, dependency order, v1 shape |
| [docs/stage-0.md](docs/stage-0.md) | Blockers — S0-1 sizes the whole product |
| [research/wiki/index.md](research/wiki/index.md) | Product thesis, incident taxonomy, failure modes |
| [AGENTS.md](AGENTS.md) | Rules for AI agents working on this repository |

## Stack

TypeScript · NestJS monorepo · PostgreSQL (+pgvector) · Redis/BullMQ · Docker sandbox.
See the constitution's technology table for the full list and the reasoning.
