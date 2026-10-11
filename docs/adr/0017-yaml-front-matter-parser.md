# ADR 0017: `yaml` for repository front matter

## Status

Accepted — 2026-10-10

## Context

005's repository-markdown adapter reads machine-readable YAML front matter from documents in the
customer's repository ([retrieval-contract §4](../../specs/005-knowledge-and-expected-behavior/contracts/retrieval-contract.md)).
The repository has no YAML parser among its direct dependencies. The input is untrusted data
(customer-authored files), a malformed block must fail that file with a named `FRONT_MATTER_INVALID`
error, and duplicate keys must not silently shadow each other.

## Decision

Add **`yaml`** (eemeli/yaml; MIT, no runtime dependencies, pure JS, YAML 1.2), `^2.9.1`.

Rejected:

- `gray-matter` — pulls js-yaml 3 and eval-capable engines (JavaScript/CoffeeScript front matter).
  Unacceptable for untrusted input.
- `js-yaml` — v4's default schema is safe, but its errors carry weaker positions and it has no
  duplicate-key strictness as a first-class option.

Safety posture (the adapter, not the library, is the reader that enforces it):

- The front-matter block is capped at **64 KiB**, checked **before** parsing.
- Parse with `parseDocument(text, { schema: 'core', logLevel: 'silent', uniqueKeys: true,
  maxAliasCount: 10, strict: true })` — core schema, no custom tags. `logLevel` must be `silent`
  because `console` is forbidden. `maxAliasCount: 10` bounds alias expansion (billion-laughs). The `yaml` typings reject
  `maxAliasCount` as a `parseDocument` option, so the bound is applied at conversion:
  `doc.toJS({ maxAliasCount: 10 })`. A measured test pins it (005 T017, amended 2026-10-10).
- Then **fail** if `doc.errors.length || doc.warnings.length`: an unresolved tag such as
  `!!js/function` only *warns*, so checking errors alone would let it through. Failure is
  `FRONT_MATTER_INVALID` carrying the library's line/column.
- The value (`doc.toJS()`) is validated by a Zod schema; nothing is read from it unvalidated. That
  schema must also reject duplicate `expected_behaviors[].id` stable keys — `uniqueKeys` covers
  mapping keys, not list items.

## Consequences

- \+ One small dependency, no transitive runtime tree, already present transitively in the pnpm store.
- \+ Error positions for the named ingest failure come for free.
- − Another dependency to track; its approval lives in `scripts/gates/deps-check.mjs` and this ADR.
