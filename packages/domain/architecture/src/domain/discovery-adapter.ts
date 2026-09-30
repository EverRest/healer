import type {
  ComponentCandidate,
  DeploymentUnitCandidate,
  DependencyObservation,
  RepositoryRef,
} from '@healer/boundary-contract';
import type { GraphLayer, ProvenanceClass } from './provenance.js';

// T017: the four discovery shapes are the types inferred from the closed Zod schemas in
// @healer/boundary-contract (FR-021, R-11, contracts/graph-contract.md §3) — this file no longer
// declares its own placeholders, so there is exactly one definition of each shape.
export type { ComponentCandidate, DeploymentUnitCandidate, DependencyObservation, RepositoryRef };

export interface DiscoveryScope {
  readonly tenantId: string;
  readonly runnerId: string;
  // Added by T003: `collect` is contracted as read-only, bounded and cancellable
  // (graph-contract.md §3) — the shape had no way to signal cancellation until an adapter
  // needed one. Optional so every existing caller is unaffected.
  readonly signal?: AbortSignal;
}

export interface DiscoveryFacts {
  readonly componentCandidates: readonly ComponentCandidate[];
  readonly deploymentUnitCandidates: readonly DeploymentUnitCandidate[];
  readonly dependencyObservations: readonly DependencyObservation[];
  readonly repositoryRefs: readonly RepositoryRef[];
}

/**
 * The only place architecture-specific logic exists (FR-020, SC-008).
 * `provenance` is a constant of the adapter, not a value it chooses per element —
 * an adapter reading folder names has no field in which to claim `derived_from_trace`.
 */
export interface DiscoveryAdapter {
  readonly key: string;
  readonly version: string;
  readonly layer: GraphLayer;
  readonly provenance: ProvenanceClass;
  collect(scope: DiscoveryScope): Promise<DiscoveryFacts>;
}
