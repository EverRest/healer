import type { DependencyObservation } from '@healer/boundary-contract';

/**
 * Closed provenance set (FR-005), derived from the wire schema rather than duplicated —
 * `packages/boundary-contract` has zero workspace dependencies by design (ADR 0001, the execution
 * boundary must not know about domain packages), so it cannot depend on this package; this package
 * already depends on `@healer/boundary-contract`, so deriving here is what keeps the closed list to
 * exactly one authority (AGENTS.md) instead of two hand-kept-in-sync copies. Strength ordinals and
 * confidence scoring are T007/R-15's job.
 */
export type ProvenanceClass = DependencyObservation['provenance'];

export type GraphLayer = DependencyObservation['layer'];
