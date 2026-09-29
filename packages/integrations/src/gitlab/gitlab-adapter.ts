import type { DiscoveryAdapter, DiscoveryFacts, DiscoveryScope } from '@healer/domain-architecture';

const EMPTY_FACTS: DiscoveryFacts = Object.freeze({
  componentCandidates: [],
  deploymentUnitCandidates: [],
  dependencyObservations: [],
  repositoryRefs: [],
});

/**
 * Repository and code-layer discovery — AST, imports, type graph (ts-morph) over a GitLab
 * project. The adapter-level `provenance`/`layer` are fixed at `derived_from_code`/`code`:
 * `Object.freeze` plus `as const` below mean nothing holding a reference can reassign them at
 * runtime, so this adapter has no way to claim a stronger class for itself (FR-020,
 * contracts/graph-contract.md §3).
 *
 * Known gap, not fixed here: `DependencyObservation` (discovery-adapter.ts) still carries its own
 * free per-element `provenance`/`layer` — a placeholder shape the file's own comment says T017
 * replaces with boundary-contract Zod-inferred types. T017 must close that gap (drop the field and
 * stamp it from the adapter, or validate it against the adapter at ingest); nothing exploits it
 * today because `collect` below only ever returns empty arrays.
 *
 * Skeleton for T003 — real collection is Phase 3 (US1). `collect` is read-only, bounded and
 * cancellable in shape only: it honours `scope.signal` and returns the empty envelope. The
 * single-shot `throwIfAborted()` check is sufficient while there are no awaited calls in between;
 * once Phase 3 adds real awaited I/O, a long collect needs a `signal` listener (or a recheck after
 * each await), not just this initial check.
 */
export const gitlabAdapter = Object.freeze({
  key: 'gitlab',
  version: '0.1.0',
  layer: 'code',
  provenance: 'derived_from_code',
  async collect(scope: DiscoveryScope): Promise<DiscoveryFacts> {
    scope.signal?.throwIfAborted();
    return EMPTY_FACTS;
  },
} as const) satisfies DiscoveryAdapter;
