import type {
  ComponentCandidate,
  DeploymentUnitCandidate,
  DependencyObservation,
  RepositoryRef,
  RunnerEvidence,
} from '@healer/boundary-contract';
import type { GraphLayer, ProvenanceClass } from './provenance.js';

// T017: the four discovery shapes are the types inferred from the closed Zod schemas in
// @healer/boundary-contract (FR-021, R-11, contracts/graph-contract.md §3) — this file no longer
// declares its own placeholders, so there is exactly one definition of each shape.
export type { ComponentCandidate, DeploymentUnitCandidate, DependencyObservation, RepositoryRef };

/** 012's `collection_gap` shape — what an adapter skipped and why (FR-023, quickstart 42). */
export type CollectionGap = Extract<RunnerEvidence, { kind: 'collection_gap' }>;

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
  /** Regions the adapter could not read (an unparsable manifest, say); the rest is still returned
   *  (FR-023, T032). Names what was skipped — never its content. */
  readonly collectionGaps: readonly CollectionGap[];
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
