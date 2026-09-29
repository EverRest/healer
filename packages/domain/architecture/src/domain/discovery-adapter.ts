import type { GraphLayer, ProvenanceClass } from './provenance.js';

export interface DiscoveryScope {
  readonly tenantId: string;
  readonly runnerId: string;
  // Added by T003: `collect` is contracted as read-only, bounded and cancellable
  // (graph-contract.md §3) — the shape had no way to signal cancellation until an adapter
  // needed one. Optional so every existing caller is unaffected.
  readonly signal?: AbortSignal;
}

// T017 replaces these four shapes with the types inferred from the closed Zod schemas
// added to @healer/boundary-contract (FR-021, R-11) — kept here only until that lands,
// so this file is the single place both are reconciled.
export interface ComponentCandidate {
  readonly naturalKey: string;
  readonly name: string;
  readonly componentType: string;
  readonly characteristics: readonly string[];
  readonly ownerRef?: string;
  readonly sourcePaths: readonly string[];
  readonly adapterKey: string;
  readonly adapterVersion: string;
}

export interface DeploymentUnitCandidate {
  readonly naturalKey: string;
  readonly environment: string;
  readonly runtimeKind: string;
  readonly runtimeRef: string;
  readonly currentVersion: string;
  readonly lastDeployedAt?: string;
}

export interface DependencyObservation {
  readonly fromNaturalKey: string;
  readonly toNaturalKey: string;
  readonly edgeType: string;
  readonly layer: GraphLayer;
  readonly provenance: ProvenanceClass;
  readonly observationCount: number;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly windowSeconds: number;
}

export interface RepositoryRef {
  readonly projectRef: string;
  readonly defaultBranch: string;
  readonly headSha: string;
  readonly componentNaturalKeys: readonly string[];
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
