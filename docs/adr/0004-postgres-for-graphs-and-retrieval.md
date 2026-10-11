# ADR 0004: Postgres for graphs and retrieval

## Status

Accepted — 2026-09-23. Amended 2026-10-10 (005 R-10): the full-text configuration is named below.

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

Built-in, not an extension (nothing to `CREATE EXTENSION`, listed so the dependency surface is complete):

| Facility | Used for |
|----------|----------|
| full-text configuration `simple` | the `tsvector` lexical path over knowledge sections (005); language-neutral (no stemming, no stop words) and deterministic — the same text yields the same lexemes on every Postgres build and locale, so SC-005 ranking is reproducible |

A language-specific configuration (`english`, …) is a new row here, because it changes what matches.

### Amendment — 2026-10-10

005 (knowledge and expected behaviour) names its Postgres facilities explicitly: extensions `vector`
and `pg_trgm` (unchanged) and the built-in `simple` text-search configuration. No new extension is
approved by this amendment.

What enforces what: the dependency gate (`scripts/gates/deps-check.mjs`) checks only the
`extensions = [...]` list in `schema.prisma` against `vector` and `pg_trgm`. It does **not** check
the text-search configuration. Today the `simple` claim is enforced by review alone; asserting that
the generated `search_vector` uses the `simple` regconfig belongs in the 005 schema migration test
(owned by the schema work) and is a follow-up, not a gate that exists.

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
