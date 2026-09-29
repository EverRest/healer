import type { DiscoveryAdapter, DiscoveryFacts, DiscoveryScope } from '@healer/domain-architecture';

const EMPTY_FACTS: DiscoveryFacts = {
  componentCandidates: [],
  deploymentUnitCandidates: [],
  dependencyObservations: [],
  repositoryRefs: [],
};

/**
 * Trace-derived dependency discovery — OpenTelemetry spans. `provenance` is fixed at
 * `derived_from_trace`: this adapter has no field in which to claim a stronger class (FR-020,
 * contracts/graph-contract.md §3).
 *
 * Skeleton for T003 — real collection is Phase 3 (US1). `collect` is read-only, bounded and
 * cancellable in shape only: it honours `scope.signal` and returns the empty envelope.
 */
export const otelAdapter = {
  key: 'otel',
  version: '0.1.0',
  layer: 'runtime',
  provenance: 'derived_from_trace',
  async collect(scope: DiscoveryScope): Promise<DiscoveryFacts> {
    scope.signal?.throwIfAborted();
    return EMPTY_FACTS;
  },
} satisfies DiscoveryAdapter;
