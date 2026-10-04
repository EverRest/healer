import type { GraphEdgeType } from './closed-vocabularies.js';
import type { ConfirmedEdge, ConfirmedNode } from './confirmed-graph-snapshot.js';
import type { MachineProvenanceClass } from './edge-observation.js';
import { edgeKey, nodeRefKey } from './node-key.js';
import { canonicalJson } from './proposal-digest.js';
import type { DiscoveryNodeKind, ProposedPayload } from './proposed-payload.js';
import type { ProvenanceClass } from './provenance.js';
import type { DraftItemOp } from './diff-builder.js';

/**
 * `sameAttributes` (`attribute-normalisation.ts`) is a plain `JSON.stringify` equality, correct
 * only when *neither* side has been round-tripped through a jsonb column — Postgres's jsonb type
 * does not preserve object key insertion order (confirmed empirically: a `current` snapshot
 * written as `{ name, attributes: {...} }` and read back through `draft_item.current` came back
 * with a different key order than the freshly-built live-side object, even though both were
 * semantically identical — `sameAttributes` reported a spurious mismatch). `canonicalJson`
 * (`proposal-digest.ts`) sorts keys before comparing, exactly like the digest it was built for,
 * so this rebase check is correct regardless of which side went through the database.
 */
function sameShape(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** The live graph, read at the moment of confirmation (never at the draft's `base_version`) — the
 *  one signal T027/T028's rebase needs: has this item's target moved since the run that proposed
 *  it? Shaped like `ConfirmedGraphSnapshot` plus the two id-indexed maps a `target_node_id`/
 *  `target_edge_id` lookup needs that a natural-key-only snapshot doesn't carry. */
export interface LiveGraphSnapshot {
  readonly nodesByKey: ReadonlyMap<string, ConfirmedNode>;
  readonly nodesById: ReadonlyMap<string, ConfirmedNode>;
  readonly edgeKeys: ReadonlySet<string>;
  readonly edgesById: ReadonlyMap<string, ConfirmedEdge>;
}

export interface DraftItemForDecision {
  readonly id: string;
  readonly op: DraftItemOp;
  readonly targetNodeId: string | null;
  readonly targetEdgeId: string | null;
  readonly proposed: ProposedPayload;
  readonly current: unknown | null;
  readonly observationRef: string | null;
  /** The machine provenance class this item was proposed with (004 reconciliation batch (a)) —
   *  an `add_edge` decision carries it forward so confirm can merge the machine observation
   *  through `mergeObservationInTx` before recording the separate human confirmation (C-87). */
  readonly provenance: ProvenanceClass;
}

export type DraftItemDecision =
  | { readonly kind: 'superseded' }
  | {
      readonly kind: 'add_node';
      readonly nodeId: string;
      readonly nodeKind: DiscoveryNodeKind;
      readonly naturalKey: string;
      readonly name: string;
      readonly attributes: unknown;
    }
  | {
      readonly kind: 'add_edge';
      readonly edgeId: string;
      readonly fromNodeId: string;
      readonly toNodeId: string;
      readonly fromNodeKind: DiscoveryNodeKind;
      readonly toNodeKind: DiscoveryNodeKind;
      readonly edgeType: GraphEdgeType;
      readonly layer: 'code' | 'runtime' | 'product';
      /** The item's own machine provenance and the `graph_fact` it was proposed from — the
       *  "keep the machine row" half of C-87 needs both to call `mergeObservationInTx`. Draft
       *  items whose `op` can reach here are never human-provenance (FR-009: a discovery run
       *  never writes `state = 'confirmed'`, so nothing it proposes is already human-authored). */
      readonly provenance: MachineProvenanceClass;
      readonly observationRef: string;
    }
  | {
      readonly kind: 'modify_attributes';
      readonly nodeId: string;
      readonly name: string;
      readonly attributes: unknown;
    }
  | { readonly kind: 'mark_removed_node'; readonly nodeId: string }
  | { readonly kind: 'mark_removed_edge'; readonly edgeId: string };

/** `applyDecision` is only ever reached once the batch is known to have no superseded item — its
 *  parameter excludes that member structurally rather than relying on a runtime check it would
 *  otherwise need to repeat (docs/patterns.md). */
export type AppliedDraftItemDecision = Exclude<DraftItemDecision, { readonly kind: 'superseded' }>;

function decideAddNode(
  proposed: Extract<ProposedPayload, { readonly op: 'add_node' }>,
  live: LiveGraphSnapshot,
  mintId: () => string,
): DraftItemDecision {
  const key = nodeRefKey({ nodeKind: proposed.nodeKind, naturalKey: proposed.naturalKey });
  if (live.nodesByKey.has(key)) return { kind: 'superseded' };
  return {
    kind: 'add_node',
    nodeId: mintId(),
    nodeKind: proposed.nodeKind,
    naturalKey: proposed.naturalKey,
    name: proposed.name,
    attributes: proposed.attributes,
  };
}

function decideAddEdge(
  item: DraftItemForDecision,
  proposed: Extract<ProposedPayload, { readonly op: 'add_edge' }>,
  live: LiveGraphSnapshot,
  mintId: () => string,
): DraftItemDecision {
  const key = edgeKey(proposed.from, proposed.to, proposed.edgeType, proposed.layer);
  if (live.edgeKeys.has(key)) return { kind: 'superseded' };
  const from = live.nodesByKey.get(nodeRefKey(proposed.from));
  const to = live.nodesByKey.get(nodeRefKey(proposed.to));
  // An endpoint this edge needs is not (yet, or no longer) live — identical in kind to every
  // other "the precondition this item was built against no longer holds" case above.
  if (from === undefined || to === undefined) return { kind: 'superseded' };
  return {
    kind: 'add_edge',
    edgeId: mintId(),
    fromNodeId: from.id,
    toNodeId: to.id,
    fromNodeKind: from.nodeKind,
    toNodeKind: to.nodeKind,
    edgeType: proposed.edgeType,
    layer: proposed.layer,
    // CHECK-constraint-guaranteed on `draft_item` (T026 notes): a non-human-provenance item
    // always names its `observation_ref`; an `add_edge` item is never human-provenance to begin
    // with (FR-009).
    provenance: item.provenance as MachineProvenanceClass,
    observationRef: item.observationRef!,
  };
}

function decideModifyAttributes(
  item: DraftItemForDecision,
  proposed: Extract<ProposedPayload, { readonly op: 'modify_attributes' }>,
  live: LiveGraphSnapshot,
): DraftItemDecision {
  const nodeId = item.targetNodeId;
  if (nodeId === null) return { kind: 'superseded' }; // CHECK-constraint-impossible; defensive only
  const liveNode = live.nodesById.get(nodeId);
  const liveShape =
    liveNode === undefined ? null : { name: liveNode.name, attributes: liveNode.attributes };
  if (!sameShape(liveShape, item.current)) return { kind: 'superseded' };
  return {
    kind: 'modify_attributes',
    nodeId,
    name: proposed.name,
    attributes: proposed.attributes,
  };
}

function decideMarkRemoved(item: DraftItemForDecision, live: LiveGraphSnapshot): DraftItemDecision {
  const proposed = item.proposed as Extract<ProposedPayload, { readonly op: 'mark_removed' }>;
  if (proposed.target.kind === 'node') {
    const nodeId = item.targetNodeId;
    if (nodeId === null) return { kind: 'superseded' };
    const liveNode = live.nodesById.get(nodeId);
    const liveShape =
      liveNode === undefined ? null : { name: liveNode.name, attributes: liveNode.attributes };
    if (!sameShape(liveShape, item.current)) return { kind: 'superseded' };
    return { kind: 'mark_removed_node', nodeId };
  }
  const edgeId = item.targetEdgeId;
  if (edgeId === null) return { kind: 'superseded' };
  if (!live.edgesById.has(edgeId)) return { kind: 'superseded' };
  return { kind: 'mark_removed_edge', edgeId };
}

/**
 * T027/T028 (R-07): rebases one draft item against the live graph instead of the draft's stale
 * `base_version` read, and decides what applying it means. `superseded` covers every shape of
 * "the target moved under it" uniformly — a manual edit changed a node's attributes, something
 * already occupies the identity an `add_*` expected to be new, or the row an `add_edge`/
 * `mark_removed` item points at no longer resolves the way it did when the draft was built — so
 * one 409 handles every case instead of a family of near-identical checks at each call site
 * (docs/patterns.md: make the unsafe state unrecognisable by one check, not several that could
 * drift apart). `mintId` is passed in rather than called here so this stays a pure function the
 * unit tests can run without `node:crypto` nondeterminism getting in the way. Delegates per `op`
 * to a sibling function (lint's `complexity` limit, same reason `mark-removed.ts` is its own
 * module rather than inlined in `diff-builder.ts`) — this function is the dispatch table only.
 */
export function decideDraftItemApplication(
  item: DraftItemForDecision,
  live: LiveGraphSnapshot,
  mintId: () => string,
): DraftItemDecision {
  const proposed = item.proposed;
  if (proposed.op === 'add_node') return decideAddNode(proposed, live, mintId);
  if (proposed.op === 'add_edge') return decideAddEdge(item, proposed, live, mintId);
  if (proposed.op === 'modify_attributes') return decideModifyAttributes(item, proposed, live);
  return decideMarkRemoved(item, live);
}
