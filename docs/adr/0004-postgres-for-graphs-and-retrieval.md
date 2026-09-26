# ADR 0004: Postgres for graphs and retrieval

## Status

Accepted — 2026-09-23

## Context

Healer needs graph traversal (architecture graph, evidence graph, dependency and impact analysis)
and semantic retrieval over knowledge documents. The obvious reach is a graph database plus a
vector database.

## Decision

Postgres for both. Graphs via recursive CTEs; retrieval via pgvector as a **secondary index**, never
a source of truth.

Approved extensions, checked by the dependency gate (012 FR-006) — adding one requires amending
this ADR:

| Extension | Used for |
|-----------|----------|
| `vector` | semantic retrieval over knowledge sections (005), secondary index only |
| `pg_trgm` | deterministic near-duplicate detection and the lexical retrieval path (005) |

## Consequences

- \+ Two fewer operational components, two fewer failure modes, two fewer things to back up and
  secure per tenant.
- \+ Graph queries join naturally with structured filters — tenant, component, time window — which
  is what most real queries need.
- \+ Structured data stays authoritative; embeddings are a lookup aid. If the index is lost it can
  be rebuilt from source.
- − Recursive CTEs are less expressive than a graph query language, and deep traversals need care.
  Acceptable: these graphs are thousands of nodes, not millions.
- − If graph size or query complexity grows by an order of magnitude, revisit with measurements
  rather than by preference.
