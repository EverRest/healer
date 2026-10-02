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
type Provenance = Pick<ProvenanceView, 'class' | 'strength' | 'confidence'>;

export interface SystemContextNode<A> {
  readonly id: string;
  readonly name: string;
  readonly naturalKey: string;
  /** `proposed`/`confirmed`/`stale` — an agent sees how sure the graph is (FR-016). */
  readonly state: string;
  readonly provenance: Provenance;
  readonly attributes: A;
}

export interface SystemContextEdge {
  readonly id: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly edgeType: string;
  readonly layer: string;
  readonly state: string;
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
}

/** One snapshot, stated against the version it was read at (R-13). */
export interface SystemContextRepository {
  read(where: TenantScoped<object>): Promise<ReadEnvelope<SystemContext>>;
}
