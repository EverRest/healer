import type { DiscoveryAdapter, DiscoveryFacts, DiscoveryScope } from '@healer/domain-architecture';

const EMPTY_FACTS: DiscoveryFacts = Object.freeze({
  componentCandidates: [],
  deploymentUnitCandidates: [],
  dependencyObservations: [],
  repositoryRefs: [],
});

/**
 * Trace-derived dependency discovery — OpenTelemetry spans. The adapter-level `provenance`/`layer`
 * are fixed at `derived_from_trace`/`runtime`: `Object.freeze` plus `as const` below mean nothing
 * holding a reference can reassign them at runtime, so this adapter has no way to claim a stronger
 * class for itself (FR-020, contracts/graph-contract.md §3).
 *
 * Known gap, not fixed here: T017 landed the boundary-contract Zod-inferred `DependencyObservation`
 * (graph-contract.md §3 declares `layer`/`provenance` as per-observation wire fields, so the shape
 * still carries them declared, not derived), but nothing yet checks that a given observation's
 * declared `layer`/`provenance` doesn't exceed the collecting adapter's own fixed constants below —
 * that validation belongs to the ingestion step Phase 3 (US1) adds, not to the schema. Nothing
 * exploits the gap today because `collect` below only ever returns empty arrays.
 *
 * Skeleton for T003 — real collection is Phase 3 (US1). `collect` is read-only, bounded and
 * cancellable in shape only: it honours `scope.signal` and returns the empty envelope. The
 * single-shot `throwIfAborted()` check is sufficient while there are no awaited calls in between;
 * once Phase 3 adds real awaited I/O, a long collect needs a `signal` listener (or a recheck after
 * each await), not just this initial check.
 */
export const otelAdapter = Object.freeze({
  key: 'otel',
  version: '0.1.0',
  layer: 'runtime',
  provenance: 'derived_from_trace',
  async collect(scope: DiscoveryScope): Promise<DiscoveryFacts> {
    scope.signal?.throwIfAborted();
    return EMPTY_FACTS;
  },
} as const) satisfies DiscoveryAdapter;
