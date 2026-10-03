import { canonical } from './natural-key-collisions.js';
import type { NodeRef } from './proposed-payload.js';

/** The one join key everywhere a node is matched by identity rather than by minted id (R-12):
 *  `(node_kind, natural_key)`, canonical match (004 reconciliation batch (f)) — `natural_key` is
 *  a matching key, not identity (`natural-key-collisions.ts`), so "Checkout" and "checkout" must
 *  resolve to the same node rather than silently diverging into two. */
export function nodeRefKey(ref: NodeRef): string {
  return `${ref.nodeKind}|${canonical(ref.naturalKey)}`;
}

export function edgeKey(from: NodeRef, to: NodeRef, edgeType: string, layer: string): string {
  return `${nodeRefKey(from)}>${nodeRefKey(to)}|${edgeType}|${layer}`;
}
