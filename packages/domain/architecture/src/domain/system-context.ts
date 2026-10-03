import type { TenantScoped } from '@healer/shared';
import type {
  ComponentAttrValue,
  DeploymentUnitAttrValue,
  RepositoryAttrValue,
} from './kind-attributes.js';
import type { ProvenanceView } from './graph-read.js';
import type { ReadEnvelope } from './read-envelope.js';

/**
 * `SystemContext` (T049, FR-020, ADR 0007): what an agent is handed about the customer's system.
 * It names components, deployment units, repositories, characteristics and edges — and has no
 * field, at any depth, saying what *style* of system this is. An agent has nothing to branch on
 * because the shape cannot hold it; the customer's style shows up only as different data in the
 * same shape. Every field is a graph fact (a node, an attribute row, an edge); there is no
 * free-form slot to widen (`get-system-context.test.ts` pins this by type, the e2e by key walk).
 */
/**
 * Every state an element can be in *except* `rejected`: a rejected element is never part of the
 * context, so the type cannot hold one. `prisma-system-context-repository.ts` narrows the stored
 * state into this with a compile-checked function — a new stored state fails the build there until
 * it is classified here (the schema enum stays the one authority for the list).
 */
export type VisibleElementState = 'proposed' | 'confirmed' | 'stale';

type Provenance = Pick<ProvenanceView, 'class' | 'strength' | 'confidence'>;

export interface SystemContextNode<A> {
  readonly id: string;
  readonly name: string;
  readonly naturalKey: string;
  /** An agent sees how sure the graph is (FR-016). */
  readonly state: VisibleElementState;
  readonly provenance: Provenance;
  readonly attributes: A;
}

export interface SystemContextEdge {
  readonly id: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly edgeType: string;
  readonly layer: string;
  readonly state: VisibleElementState;
  readonly provenance: Provenance;
}

export interface SystemContext {
  readonly components: readonly SystemContextNode<ComponentAttrValue>[];
  readonly deploymentUnits: readonly SystemContextNode<DeploymentUnitAttrValue>[];
  readonly repositories: readonly SystemContextNode<RepositoryAttrValue>[];
  /** The distinct characteristics in use across the components, sorted. */
  readonly characteristics: readonly string[];
  /** Open, non-rejected edges whose both endpoints are among the nodes above. */
  readonly edges: readonly SystemContextEdge[];
  /**
   * Edges valid at this version, not rejected, that are NOT in `edges` because an endpoint is
   * rejected, closed or of a kind outside the three lists above (an endpoint, say). The envelope's
   * coverage is scoped to this context — nodes and edges listed here — so it can differ from the
   * graph-wide figures of `GET /graph/nodes`; this count is what keeps the difference visible.
   * Nonzero is normal (edges to endpoint nodes); an edge to a rejected or closed node is a defect
   * `check:graph-structure` reports.
   */
  readonly excludedEdges: number;
}

/** A stored node that cannot form a context entry — a broken graph, not an empty one. */
export class SystemContextInvariantError extends Error {
  constructor(
    readonly tenantId: string,
    readonly nodeId: string,
    detail: string,
  ) {
    super(`system context: tenant ${tenantId} node ${nodeId}: ${detail}`);
    this.name = 'SystemContextInvariantError';
  }
}

/** One snapshot, stated against the version it was read at (R-13). */
export interface SystemContextRepository {
  read(where: TenantScoped<object>): Promise<ReadEnvelope<SystemContext>>;
}
