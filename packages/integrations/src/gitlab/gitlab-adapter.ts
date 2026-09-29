import type { DiscoveryAdapter, DiscoveryFacts, DiscoveryScope } from '@healer/domain-architecture';

const EMPTY_FACTS: DiscoveryFacts = {
  componentCandidates: [],
  deploymentUnitCandidates: [],
  dependencyObservations: [],
  repositoryRefs: [],
};

/**
 * Repository and code-layer discovery — AST, imports, type graph (ts-morph) over a GitLab
 * project. `provenance` is fixed at `derived_from_code`: this adapter has no field in which to
 * claim a stronger class (FR-020, contracts/graph-contract.md §3).
 *
 * Skeleton for T003 — real collection is Phase 3 (US1). `collect` is read-only, bounded and
 * cancellable in shape only: it honours `scope.signal` and returns the empty envelope.
 */
export const gitlabAdapter = {
  key: 'gitlab',
  version: '0.1.0',
  layer: 'code',
  provenance: 'derived_from_code',
  async collect(scope: DiscoveryScope): Promise<DiscoveryFacts> {
    scope.signal?.throwIfAborted();
    return EMPTY_FACTS;
  },
} satisfies DiscoveryAdapter;
