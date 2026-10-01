import type { DependencyObservation } from '@healer/boundary-contract';
import type { DiscoveryAdapter, DiscoveryFacts, DiscoveryScope } from '@healer/domain-architecture';

/**
 * Read-only seam a runner-side OTLP/trace-backend client plugs into later (012-runner; no
 * credentials or config exist yet in this batch — see QUESTIONS.md "004 Phase 3 — adapter
 * collection (A2)"). Read-only by construction: there is no write method on this interface.
 */
export interface ServiceEdge {
  readonly fromService: string;
  readonly toService: string;
  readonly spanCount: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
}

export interface TraceReader {
  serviceEdges(windowSeconds: number): Promise<readonly ServiceEdge[]>;
}

const OTEL_ADAPTER_KEY = 'otel';
const OTEL_ADAPTER_VERSION = '0.2.0';
const OTEL_LAYER = 'runtime';
const OTEL_PROVENANCE = 'derived_from_trace';
// ponytail: one fixed window until a later phase threads a per-run window through DiscoveryScope —
// widen `DiscoveryScope` (or the factory's second argument, already callable with any value) if a
// caller ever needs a different window than this adapter default.
const DEFAULT_WINDOW_SECONDS = 86_400;

function toCallsObservation(edge: ServiceEdge, windowSeconds: number): DependencyObservation {
  return {
    kind: 'dependency_observation',
    fromNaturalKey: edge.fromService,
    toNaturalKey: edge.toService,
    edgeType: 'calls',
    layer: OTEL_LAYER,
    provenance: OTEL_PROVENANCE,
    observationCount: edge.spanCount,
    firstObservedAt: edge.firstSeen,
    lastObservedAt: edge.lastSeen,
    windowSeconds,
  };
}

/**
 * Trace-derived dependency discovery over OpenTelemetry service edges (FR-020,
 * contracts/graph-contract.md §3). `provenance`/`layer` are fixed by `OTEL_LAYER`/`OTEL_PROVENANCE`
 * above, reused for both the frozen adapter fields and every emitted `dependency_observation`.
 */
export function createOtelAdapter(
  reader: TraceReader,
  windowSeconds: number = DEFAULT_WINDOW_SECONDS,
) {
  return Object.freeze({
    key: OTEL_ADAPTER_KEY,
    version: OTEL_ADAPTER_VERSION,
    layer: OTEL_LAYER,
    provenance: OTEL_PROVENANCE,
    async collect(scope: DiscoveryScope): Promise<DiscoveryFacts> {
      scope.signal?.throwIfAborted();
      const edges = await reader.serviceEdges(windowSeconds);
      scope.signal?.throwIfAborted();

      return {
        componentCandidates: [],
        deploymentUnitCandidates: [],
        dependencyObservations: edges.map((edge) => toCallsObservation(edge, windowSeconds)),
        repositoryRefs: [],
        collectionGaps: [],
      };
    },
  } as const) satisfies DiscoveryAdapter;
}
