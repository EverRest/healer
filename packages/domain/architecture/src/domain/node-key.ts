import type { NodeRef } from './proposed-payload.js';

/** The one join key everywhere a node is matched by identity rather than by minted id (R-12):
 *  `(node_kind, natural_key)`, exact match — alias/collision handling is T052 (Phase 5). */
export function nodeRefKey(ref: NodeRef): string {
  return `${ref.nodeKind}|${ref.naturalKey}`;
}

export function edgeKey(from: NodeRef, to: NodeRef, edgeType: string, layer: string): string {
  return `${nodeRefKey(from)}>${nodeRefKey(to)}|${edgeType}|${layer}`;
}
