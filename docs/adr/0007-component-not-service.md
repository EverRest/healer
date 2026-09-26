# ADR 0007: Model `Component`, not `Service`

## Status

Accepted — 2026-09-23

## Context

Naming the base unit `Service` quietly commits the whole product to microservice thinking. A
monolith then becomes a special case, a frontend becomes second-class, and legacy systems do not
fit at all. Most real systems are hybrids: a frontend calling a BFF calling microservices calling a
legacy monolith calling Oracle.

## Decision

The base unit is `Component`, with a narrow `type` plus open `characteristics`. Architecture is
described by characteristics (`distributed`, `monolithic`, `event_driven`, `frontend_backend_split`),
never by a single enum — the same argument applies one level down to `ComponentType`.

Two separations that are routinely conflated:

- **Logical `Component` vs `DeploymentUnit`.** A monolith has many logical components and one
  deployment unit. Conflating them makes monoliths unmodellable.
- **`Component` ↔ `Repository` is many-to-many.** Monorepo and polyrepo are both normal.

Agents receive a `SystemContext` and know nothing about the customer's architecture style.
Architecture-specific code lives only in adapters and discovery.

## Consequences

- \+ Supporting a new architecture means a new adapter, not new agents.
- \+ Monolith, frontend and legacy are first-class rather than degenerate cases.
- − Discovery must infer the graph from incomplete sources and will never be fully correct, so every
  edge carries provenance and confidence, and the customer confirms a draft rather than receiving
  an assertion.
- − A wrong graph produces a wrong blast radius and therefore a confidently bad change. Graph drift
  is treated as an issue for a human, like knowledge drift.
- The model is general from day one; the **shipped adapter set is one stack** until the loop is
  proven (D-03).
