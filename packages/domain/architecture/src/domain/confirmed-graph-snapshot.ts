import type { GraphEdgeType } from './closed-vocabularies.js';
import type { NodeAttributes, NodeRef } from './proposed-payload.js';

/** Confirmed state at `discovery_run.base_version` (plan "The draft as a diff") — "rows with
 *  `valid_from_version <= base AND valid_to_version >= base`". Read by
 *  `PrismaDiscoveryRepository.loadConfirmedSnapshot`; consumed only by the pure diff-builder. */
export interface ConfirmedNode extends NodeRef {
  readonly id: string;
  readonly name: string;
  readonly attributes: NodeAttributes;
}

export interface ConfirmedEdge {
  readonly id: string;
  readonly from: NodeRef;
  readonly to: NodeRef;
  readonly edgeType: GraphEdgeType;
  readonly layer: 'code' | 'runtime' | 'product';
  /** Distinct `edge_provenance.adapter_key` values for this edge — `mark_removed` eligibility
   *  needs every one of them to have run `collected` this run (plan "The draft as a diff"). Empty
   *  for an edge nothing ever recorded provenance for (should not happen for a discovery-sourced
   *  edge, but a human-authored one legitimately has none — such an edge is never a `mark_removed`
   *  candidate, since there is no adapter whose non-collection would license removing it). */
  readonly contributingAdapterKeys: readonly string[];
}

export interface ConfirmedGraphSnapshot {
  readonly nodes: readonly ConfirmedNode[];
  readonly edges: readonly ConfirmedEdge[];
}
