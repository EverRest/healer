import type { TenantScoped } from '@healer/shared';
import type { ReadEnvelope } from './read-envelope.js';
import type { GraphLayer, ProvenanceClass } from './provenance.js';

/** What every node and edge says about where it came from (FR-006, FR-007). */
export interface ProvenanceView {
  readonly class: ProvenanceClass;
  /** The stored ordinal — read back, never re-derived (R-03). */
  readonly strength: number;
  /** The stored 0-100 value, written once at insert (R-15). */
  readonly confidence: number;
  /** `evidence.id` of the observation; null only for the two human classes. */
  readonly observationRef: string | null;
  /** The named human, for the two human classes. */
  readonly actorRef: string | null;
}

export interface GraphNodeView {
  readonly id: string;
  readonly nodeKind: string;
  readonly layer: GraphLayer;
  readonly name: string;
  readonly naturalKey: string;
  readonly state: string;
  readonly lifecycleState: string;
  readonly provenance: ProvenanceView;
  /** Which discovery run produced it; null for a human-authored node. */
  readonly discoveryRunId: string | null;
}

/** Every provenance retained when sources agree (FR-008). */
export interface ContributingSource {
  readonly class: ProvenanceClass;
  readonly adapterKey: string;
  readonly observationRef: string | null;
  readonly strength: number;
  readonly confidence: number;
  readonly discoveryRunId: string | null;
}

export interface GraphEdgeView {
  readonly id: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly edgeType: string;
  readonly layer: GraphLayer;
  readonly state: string;
  readonly observationCount: number;
  readonly lastObservedAt: Date | null;
  /**
   * True when no `edge_provenance` row is visible for this edge at the version read: what
   * `provenance` then shows is only the edge's own stored columns, not a source anyone can
   * resolve. Never absent, so a consumer cannot mistake an unsourced edge for a sourced one.
   *
   * Otherwise class, strength, confidence and observationRef all come from ONE row: the
   * strongest (ties: earliest recorded, then id), so what is shown is internally consistent.
   */
  readonly provenanceUnresolved: boolean;
  readonly provenance: ProvenanceView & {
    readonly contributingSources: readonly ContributingSource[];
  };
}

export interface GraphNodeFilter {
  readonly nodeKind?: string;
  readonly layer?: string;
  readonly state?: string;
  /**
   * Explanation filter only (FR-016): it narrows what a human is shown. It exists on this read
   * surface and on no impact or policy path.
   */
  readonly minStrength?: number;
  /** Pin to a graph version; omitted resolves to the tenant's current one, stated in the envelope. */
  readonly graphVersion?: number;
}

/** A filter value outside the closed set — the caller's mistake, not a missing node. */
export class InvalidGraphFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidGraphFilterError';
  }
}

/**
 * The read side of the graph (T041). Both reads return the envelope (R-13), never a bare list.
 * `getNode` throws `NotFoundError` for a node that does not exist *or* belongs to another tenant
 * (FR-024): the two are indistinguishable from outside.
 */
export interface GraphReadRepository {
  listNodes(where: TenantScoped<GraphNodeFilter>): Promise<ReadEnvelope<readonly GraphNodeView[]>>;
  getNode(
    where: TenantScoped<{ readonly id: string; readonly graphVersion?: number }>,
  ): Promise<
    ReadEnvelope<{ readonly node: GraphNodeView; readonly edges: readonly GraphEdgeView[] }>
  >;
}
