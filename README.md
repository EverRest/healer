# Healer

Healer takes an issue and turns it into a diagnosis that evidence supports. An issue can be a
production incident, a user report, an alert or a regression. When policy permits, Healer also turns
the issue into a verified change.

**The LLM is not the center of this architecture.** The center is Evidence + Domain State + Policy
+ Verification. The model proposes. Evidence, policy and verification decide.

> Quality comes from the loop. It does not come from the model.

## Status

The specifications of all thirteen features are complete: 399 functional requirements, 148 success
criteria, ~1221 tasks. All clarifications are resolved. **Implementation (VERSION 0.37.0):**

- **012 engineering-foundation — 67/96 tasks.** The monorepo, tenancy as a compile-time guarantee,
  the workflow machine, the full gate suite (`make ci`), boundary lint rules, the runner protocol
  schemas, the transactional outbox, the prompt registry and self-observation.
- **001 issue-and-evidence — 26/57 tasks. Phases 1–3 are complete** (Foundational + US1
  dedup/ingest): append-only evidence, the issue state machine, fingerprint normalization,
  `POST /ingest/signals`, idempotent delivery, reopen/recurrence and the real BullMQ consumer.
  A load check found and fixed a real concurrency bug. A burst of a new fingerprint used to split
  into several issues. It now makes one issue.
- **002–011, 013 — not started.** Dependency order: 012 → 001 → 002 → 003 → 004 → 005 → 006 → 011
  → 009 → 010 → 007 → 008 → 013.

For the exact phase state, see [docs/roadmap.md](docs/roadmap.md). For what landed and why, see
[docs/changelog.md](docs/changelog.md). For what still blocks a realistic size estimate of v1, see
[docs/stage-0.md](docs/stage-0.md).

## Run it locally

```bash
make bootstrap      # install, start Postgres + Redis, migrate, seed — one command, no manual step
make ci             # the full gate set: secret-scan, lint, typecheck, build, tests, contract drift
```

Use these focused targets for fast iteration: `make lint`, `make typecheck`, `make test-unit`,
`make test-e2e` (needs Docker) and `make db-check`. `make help` lists every target.

`test-e2e` starts real, disposable Postgres and Redis containers for each test file (testcontainers).
The suite has no mocked database and no mocked queue. `apps/api/load.e2e.test.ts` is the only load
test today. It starts the real HTTP server and the real `apps/worker` consumer together. It proves
that signal ingestion does not lose issues and does not split issues under sustained concurrent load.

## What v1 is

```text
Issue → Context → Evidence → Diagnosis          all sources, one pipeline
      → Reproduction → TDD fix → Pull request   a human always merges (L2 ceiling)
      → AutoSupport proposal                    Healer never sends
      → Regression suite                        adopted expectations → tests → CI → issues
      → Safe remediation                        reversible actions, autonomous rollback
```

Autonomy is granted for each tenant, component, environment and action. It is never granted globally.
The ceiling for year one is L2: Healer opens pull requests and humans merge them.

Client-side reproduction (007/008) uses Playwright when a symptom is visible only in a browser.
This is a **product capability** to reproduce a client-side issue of a customer. It is not a tool for
the test suite. See [decisions.md](docs/decisions.md) C-24..C-28.

## Deployment

The deployment is hybrid. Healer owns the control plane (issues, evidence, policy, agents,
knowledge, dashboard). The execution plane runs in the infrastructure of the customer. It contains
the repository checkout, the sandbox, tests, code intelligence, log collection and redaction, and
remediation. Only structured evidence crosses the boundary. Raw logs never cross it.

**Open gap. It is not specified and not built.** It is not defined where and how the *own* control
plane of Healer is deployed to a real, running environment. This includes staging/production
hosting, a release workflow beyond the `make ci` run on push/PR in `.github/workflows/ci.yml`,
post-deploy smoke checks and automatic rollback after a failed health check. 012 FR-052 says only
that v1 *must not* need Kubernetes or Terraform. It names no positive target. There is also no
automated browser-level smoke or regression suite for a *running* Healer deployment. Today,
Playwright is used only as the product capability above. It is not used as a check against our own
environments. `QUESTIONS.md` flags this gap. The person who chooses a hosting target and a release
process must resolve it. This is new infrastructure. It needs an ADR, as this repository requires.
Do not invent a solution silently.

## Reading order

| Document | Why |
|----------|-----|
| [.specify/memory/constitution.md](.specify/memory/constitution.md) | Principles. A violation of I, II or IV blocks the merge |
| [docs/decisions.md](docs/decisions.md) | What the team decided and why, with the rejected options |
| [docs/roadmap.md](docs/roadmap.md) | Specs, dependency order, v1 shape, exact phase state |
| [docs/changelog.md](docs/changelog.md) | What landed, in what order, and why — the detailed build log |
| [docs/stage-0.md](docs/stage-0.md) | Blockers and values that are unset on purpose — S0-1 sizes the whole product |
| [QUESTIONS.md](QUESTIONS.md) | Open judgment calls and known gaps that wait for review |
| [research/wiki/index.md](research/wiki/index.md) | Product thesis, incident taxonomy, failure modes, agent-driven development |
| [AGENTS.md](AGENTS.md) | Rules for AI agents that work on this repository |

## Stack

TypeScript · NestJS monorepo · PostgreSQL (+pgvector) · Redis/BullMQ · Docker sandbox.
The technology table in the constitution gives the full list and the reasons.

## Build Healer with agents

Coding agents build most of the repository of Healer. They work against the task lists in `specs/`
(012 US10, [ADR 0011](docs/adr/0011-agent-driven-development.md)). Prompt text does not constrain an
agent. These controls constrain it: the bot identity on the repository host, protected paths, a gate
that catches a weakened test, and a merge ruleset that the agent cannot bypass.
[research/wiki/agent-driven-development.md](research/wiki/agent-driven-development.md) describes them.
Thirteen ADRs record each decision about a new dependency or pattern so far ([docs/adr/](docs/adr/)).
