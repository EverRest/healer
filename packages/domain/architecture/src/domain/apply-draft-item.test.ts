import { describe, expect, it } from 'vitest';
import {
  decideDraftItemApplication,
  type DraftItemForDecision,
  type LiveGraphSnapshot,
} from './apply-draft-item.js';
import type { ConfirmedEdge, ConfirmedNode } from './confirmed-graph-snapshot.js';
import { edgeKey, nodeRefKey } from './node-key.js';

/**
 * T027/T028 (R-07): the rebase decision is pure, so every "target moved under it" shape is
 * proven here without a database — the e2e suite (`confirm-reject-draft-items.e2e.test.ts`) then
 * only has to prove the *repository* wires this function up correctly under a real lock, not
 * re-prove each shape of supersession against Postgres.
 */

const COMPONENT_ATTRS = { componentType: 'service', characteristics: [], ownerRef: null } as const;

function emptySnapshot(): LiveGraphSnapshot {
  return { nodesByKey: new Map(), nodesById: new Map(), edgeKeys: new Set(), edgesById: new Map() };
}

function withNode(snapshot: LiveGraphSnapshot, node: ConfirmedNode): LiveGraphSnapshot {
  const nodesByKey = new Map(snapshot.nodesByKey);
  const nodesById = new Map(snapshot.nodesById);
  nodesByKey.set(nodeRefKey(node), node);
  nodesById.set(node.id, node);
  return { ...snapshot, nodesByKey, nodesById };
}

function withEdge(snapshot: LiveGraphSnapshot, edge: ConfirmedEdge): LiveGraphSnapshot {
  const edgeKeys = new Set(snapshot.edgeKeys);
  const edgesById = new Map(snapshot.edgesById);
  edgeKeys.add(edgeKey(edge.from, edge.to, edge.edgeType, edge.layer));
  edgesById.set(edge.id, edge);
  return { ...snapshot, edgeKeys, edgesById };
}

const mintId = () => 'minted-id';

function addNodeItem(naturalKey: string): DraftItemForDecision {
  return {
    id: 'item-1',
    op: 'add_node',
    targetNodeId: null,
    targetEdgeId: null,
    proposed: {
      op: 'add_node',
      nodeKind: 'component',
      naturalKey,
      name: naturalKey,
      attributes: COMPONENT_ATTRS,
    },
    current: null,
    observationRef: 'obs-1',
    provenance: 'derived_from_code',
  };
}

describe('decideDraftItemApplication: add_node', () => {
  it('applies when no live node occupies the identity', () => {
    const decision = decideDraftItemApplication(addNodeItem('svc-a'), emptySnapshot(), mintId);
    expect(decision).toEqual({
      kind: 'add_node',
      nodeId: 'minted-id',
      nodeKind: 'component',
      naturalKey: 'svc-a',
      name: 'svc-a',
      attributes: COMPONENT_ATTRS,
    });
  });

  it('is superseded when a live node already occupies the identity', () => {
    const live = withNode(emptySnapshot(), {
      id: 'existing',
      nodeKind: 'component',
      naturalKey: 'svc-a',
      name: 'svc-a',
      attributes: COMPONENT_ATTRS,
    });
    expect(decideDraftItemApplication(addNodeItem('svc-a'), live, mintId)).toEqual({
      kind: 'superseded',
    });
  });
});

function addEdgeItem(): DraftItemForDecision {
  return {
    id: 'item-2',
    op: 'add_edge',
    targetNodeId: null,
    targetEdgeId: null,
    proposed: {
      op: 'add_edge',
      from: { nodeKind: 'component', naturalKey: 'a' },
      to: { nodeKind: 'component', naturalKey: 'b' },
      edgeType: 'depends_on',
      layer: 'code',
    },
    current: null,
    observationRef: 'obs-2',
    provenance: 'derived_from_code',
  };
}

const NODE_A: ConfirmedNode = {
  id: 'id-a',
  nodeKind: 'component',
  naturalKey: 'a',
  name: 'a',
  attributes: COMPONENT_ATTRS,
};
const NODE_B: ConfirmedNode = {
  id: 'id-b',
  nodeKind: 'component',
  naturalKey: 'b',
  name: 'b',
  attributes: COMPONENT_ATTRS,
};

describe('decideDraftItemApplication: add_edge', () => {
  it('applies when both endpoints resolve live and no edge exists yet', () => {
    const live = withNode(withNode(emptySnapshot(), NODE_A), NODE_B);
    expect(decideDraftItemApplication(addEdgeItem(), live, mintId)).toEqual({
      kind: 'add_edge',
      edgeId: 'minted-id',
      fromNodeId: 'id-a',
      toNodeId: 'id-b',
      fromNodeKind: 'component',
      toNodeKind: 'component',
      edgeType: 'depends_on',
      layer: 'code',
      provenance: 'derived_from_code',
      observationRef: 'obs-2',
    });
  });

  it('is superseded when the edge already exists live', () => {
    let live = withNode(withNode(emptySnapshot(), NODE_A), NODE_B);
    live = withEdge(live, {
      id: 'edge-1',
      from: { nodeKind: 'component', naturalKey: 'a' },
      to: { nodeKind: 'component', naturalKey: 'b' },
      edgeType: 'depends_on',
      layer: 'code',
      contributingAdapterKeys: [],
    });
    expect(decideDraftItemApplication(addEdgeItem(), live, mintId)).toEqual({ kind: 'superseded' });
  });

  it('is superseded when an endpoint does not resolve live (e.g. never confirmed, or removed)', () => {
    const live = withNode(emptySnapshot(), NODE_A); // "b" missing
    expect(decideDraftItemApplication(addEdgeItem(), live, mintId)).toEqual({ kind: 'superseded' });
  });
});

function modifyAttributesItem(current: unknown): DraftItemForDecision {
  return {
    id: 'item-3',
    op: 'modify_attributes',
    targetNodeId: 'node-1',
    targetEdgeId: null,
    proposed: {
      op: 'modify_attributes',
      nodeKind: 'component',
      naturalKey: 'svc-a',
      name: 'svc-a',
      attributes: { componentType: 'service', characteristics: ['user_facing'], ownerRef: null },
    },
    current,
    observationRef: 'obs-3',
    provenance: 'derived_from_code',
  };
}

describe('decideDraftItemApplication: modify_attributes (T027/T028 rebase)', () => {
  const liveShape = { name: 'svc-a', attributes: COMPONENT_ATTRS };

  it('applies when the live node still matches the draft-time snapshot', () => {
    const live = withNode(emptySnapshot(), {
      id: 'node-1',
      nodeKind: 'component',
      naturalKey: 'svc-a',
      name: 'svc-a',
      attributes: COMPONENT_ATTRS,
    });
    expect(decideDraftItemApplication(modifyAttributesItem(liveShape), live, mintId)).toEqual({
      kind: 'modify_attributes',
      nodeId: 'node-1',
      name: 'svc-a',
      attributes: { componentType: 'service', characteristics: ['user_facing'], ownerRef: null },
    });
  });

  it('is superseded when a manual edit changed the node after the run (R-07, T027)', () => {
    const live = withNode(emptySnapshot(), {
      id: 'node-1',
      nodeKind: 'component',
      naturalKey: 'svc-a',
      name: 'svc-a-renamed-by-hand', // diverged from the draft's `current` snapshot
      attributes: COMPONENT_ATTRS,
    });
    expect(decideDraftItemApplication(modifyAttributesItem(liveShape), live, mintId)).toEqual({
      kind: 'superseded',
    });
  });

  it('is superseded when the node no longer exists live', () => {
    expect(
      decideDraftItemApplication(modifyAttributesItem(liveShape), emptySnapshot(), mintId),
    ).toEqual({
      kind: 'superseded',
    });
  });
});

function markRemovedNodeItem(current: unknown): DraftItemForDecision {
  return {
    id: 'item-4',
    op: 'mark_removed',
    targetNodeId: 'node-1',
    targetEdgeId: null,
    proposed: {
      op: 'mark_removed',
      target: { kind: 'node', nodeKind: 'component', naturalKey: 'svc-a' },
    },
    current,
    observationRef: 'obs-4',
    provenance: 'derived_from_code',
  };
}

describe('decideDraftItemApplication: mark_removed (node)', () => {
  const liveShape = { name: 'svc-a', attributes: COMPONENT_ATTRS };

  it('applies when the live node still matches the draft-time snapshot', () => {
    const live = withNode(emptySnapshot(), {
      id: 'node-1',
      nodeKind: 'component',
      naturalKey: 'svc-a',
      name: 'svc-a',
      attributes: COMPONENT_ATTRS,
    });
    expect(decideDraftItemApplication(markRemovedNodeItem(liveShape), live, mintId)).toEqual({
      kind: 'mark_removed_node',
      nodeId: 'node-1',
    });
  });

  it('is superseded when the node was already changed or removed by someone else', () => {
    expect(
      decideDraftItemApplication(markRemovedNodeItem(liveShape), emptySnapshot(), mintId),
    ).toEqual({
      kind: 'superseded',
    });
  });
});

function markRemovedEdgeItem(): DraftItemForDecision {
  return {
    id: 'item-5',
    op: 'mark_removed',
    targetNodeId: null,
    targetEdgeId: 'edge-1',
    proposed: {
      op: 'mark_removed',
      target: {
        kind: 'edge',
        from: { nodeKind: 'component', naturalKey: 'a' },
        to: { nodeKind: 'component', naturalKey: 'b' },
        edgeType: 'depends_on',
        layer: 'code',
      },
    },
    current: {
      from: { nodeKind: 'component', naturalKey: 'a' },
      to: { nodeKind: 'component', naturalKey: 'b' },
      edgeType: 'depends_on',
      layer: 'code',
    },
    observationRef: 'obs-5',
    provenance: 'derived_from_code',
  };
}

describe('decideDraftItemApplication: mark_removed (edge)', () => {
  it('applies when the live edge still resolves by id', () => {
    const live = withEdge(emptySnapshot(), {
      id: 'edge-1',
      from: { nodeKind: 'component', naturalKey: 'a' },
      to: { nodeKind: 'component', naturalKey: 'b' },
      edgeType: 'depends_on',
      layer: 'code',
      contributingAdapterKeys: [],
    });
    expect(decideDraftItemApplication(markRemovedEdgeItem(), live, mintId)).toEqual({
      kind: 'mark_removed_edge',
      edgeId: 'edge-1',
    });
  });

  it('is superseded when the edge was already removed by someone else', () => {
    expect(decideDraftItemApplication(markRemovedEdgeItem(), emptySnapshot(), mintId)).toEqual({
      kind: 'superseded',
    });
  });
});
