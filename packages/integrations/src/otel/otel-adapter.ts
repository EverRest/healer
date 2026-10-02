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
  serviceEdges(windowSeconds: number, signal?: AbortSignal): Promise<readonly ServiceEdge[]>;
}

const OTEL_ADAPTER_KEY = 'otel';
const OTEL_ADAPTER_VERSION = '0.2.0';
const OTEL_LAYER = 'runtime';
const OTEL_PROVENANCE = 'derived_from_trace';
// ponytail: one fixed window until a later phase threads a per-run window through DiscoveryScope —
// widen `DiscoveryScope` (or the factory's second argument, already callable with any value) if a
// caller ever needs a different window than this adapter default.
const DEFAULT_WINDOW_SECONDS = 86_400;

const HAS_ZONE_DESIGNATOR = /(Z|[+-]\d{2}:?\d{2})$/;

/** The wire schema requires an offset-qualified ISO datetime (`z.string().datetime({ offset: true
 *  })`); a real trace backend can hand back a bare `2026-10-01T00:00:00` with no zone. A bare value
 *  is assumed UTC and given one explicitly — `new Date('2026-10-01T00:00:00')` alone would parse it
 *  as the *host's* local time (ECMA-262's rule for a zone-less date-time string), which would make
 *  this adapter's output depend on the machine it runs on; OTLP timestamps are always UTC, so that
 *  assumption is safe here. A value that already carries a zone is just reformatted. An unparsable
 *  value is passed through unchanged and left for egress validation to reject (`schema_rejected`)
 *  rather than dropped here. */
function toOffsetIso(value: string): string {
  const withZone = HAS_ZONE_DESIGNATOR.test(value) ? value : `${value}Z`;
  const parsed = new Date(withZone);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function toCallsObservation(edge: ServiceEdge, windowSeconds: number): DependencyObservation {
  return {
    kind: 'dependency_observation',
    fromNaturalKey: edge.fromService,
    toNaturalKey: edge.toService,
    edgeType: 'calls',
    layer: OTEL_LAYER,
    provenance: OTEL_PROVENANCE,
    observationCount: edge.spanCount,
    firstObservedAt: toOffsetIso(edge.firstSeen),
    lastObservedAt: toOffsetIso(edge.lastSeen),
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
      const edges = await reader.serviceEdges(windowSeconds, scope.signal);
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
