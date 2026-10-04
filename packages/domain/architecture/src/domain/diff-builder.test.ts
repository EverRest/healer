import { describe, expect, it } from 'vitest';
import { buildDraftItems, naturalEdgeKey, type AcceptedSourceItems } from './diff-builder.js';
import { DEFAULT_CONFIDENCE_CONFIG } from './edge-confidence.js';

describe('naturalEdgeKey (004 reconciliation batch (f)): canonical matching, not exact', () => {
  it('"Checkout" and "checkout" build the same unresolved-edge key', () => {
    expect(naturalEdgeKey('Checkout', 'Billing', 'depends_on', 'code')).toBe(
      naturalEdgeKey('checkout', 'billing', 'depends_on', 'code'),
    );
  });
});

describe('buildDraftItems confidence (004 reconciliation batch (c)): derived, not flat', () => {
  const sources: readonly AcceptedSourceItems[] = [
    {
      sourceKey: 'otel',
      finalStatus: 'collected',
      items: [
        {
          kind: 'component_candidate',
          naturalKey: 'checkout',
          name: 'checkout',
          componentType: 'service',
          characteristics: [],
          sourcePaths: [],
          adapterKey: 'otel',
          adapterVersion: '1.0.0',
        },
        {
          kind: 'component_candidate',
          naturalKey: 'billing',
          name: 'billing',
          componentType: 'service',
          characteristics: [],
          sourcePaths: [],
          adapterKey: 'otel',
          adapterVersion: '1.0.0',
        },
        {
          kind: 'dependency_observation',
          fromNaturalKey: 'checkout',
          toNaturalKey: 'billing',
          edgeType: 'calls',
          layer: 'runtime',
          provenance: 'derived_from_trace',
          observationCount: 10_000,
          firstObservedAt: '2026-01-01T00:00:00.000Z',
          lastObservedAt: '2026-01-01T00:00:00.000Z',
          windowSeconds: 3600,
        },
      ],
    },
  ];

  it('an add_edge item with real observation volume scores above the flat provenance base', () => {
    const result = buildDraftItems({
      tenantId: 't1',
      runId: 'r1',
      sources,
      adapterConstants: {
        otel: { version: '1.0.0', layer: 'runtime', provenance: 'derived_from_trace' },
      },
      snapshot: { nodes: [], edges: [] },
      rejectedDigests: new Set(),
    });
    const addEdge = result.items.find((i) => i.op === 'add_edge');
    expect(addEdge).toBeDefined();
    // High volume, fresh — above the flat derived_from_trace base (70), not equal to it.
    expect(addEdge!.confidence).toBeGreaterThan(DEFAULT_CONFIDENCE_CONFIG.base.derived_from_trace);
  });

  it('a node candidate (no observation count to derive from) gets exactly the flat base', () => {
    const result = buildDraftItems({
      tenantId: 't1',
      runId: 'r1',
      sources,
      adapterConstants: {
        otel: { version: '1.0.0', layer: 'runtime', provenance: 'derived_from_trace' },
      },
      snapshot: { nodes: [], edges: [] },
      rejectedDigests: new Set(),
    });
    const addNode = result.items.find((i) => i.op === 'add_node');
    expect(addNode?.confidence).toBe(DEFAULT_CONFIDENCE_CONFIG.base.derived_from_trace);
  });
});

describe('buildDraftItems deployment-unit placement (Phase 5 hook, T051)', () => {
  const sourcesWithUnit = (naturalKey: string): readonly AcceptedSourceItems[] => [
    {
      sourceKey: 'k8s',
      finalStatus: 'collected',
      items: [
        {
          kind: 'deployment_unit_candidate',
          naturalKey,
          environment: 'prod',
          runtimeKind: 'container',
          runtimeRef: 'ref',
          currentVersion: '1.0.0',
          lastDeployedAt: undefined,
        },
      ],
    },
  ];
  const adapterConstants = {
    k8s: {
      version: '1.0.0',
      layer: 'runtime' as const,
      provenance: 'derived_from_runtime' as const,
    },
  };

  it('an unmatched deployment unit also proposes an external component and a deploys edge', () => {
    const result = buildDraftItems({
      tenantId: 't1',
      runId: 'r1',
      sources: sourcesWithUnit('sidecar'),
      adapterConstants,
      snapshot: { nodes: [], edges: [] },
      rejectedDigests: new Set(),
    });
    const addNodes = result.items.filter((i) => i.op === 'add_node');
    expect(addNodes).toHaveLength(2);
    const external = addNodes.find(
      (i) => i.proposed.op === 'add_node' && i.proposed.nodeKind === 'component',
    );
    expect(external).toBeDefined();
    expect(external!.proposed).toMatchObject({
      op: 'add_node',
      nodeKind: 'component',
      naturalKey: 'sidecar',
      attributes: { componentType: 'external', characteristics: ['third_party'] },
    });
    const addEdge = result.items.find((i) => i.op === 'add_edge');
    expect(addEdge?.proposed).toMatchObject({
      op: 'add_edge',
      from: { nodeKind: 'component', naturalKey: 'sidecar' },
      to: { nodeKind: 'deployment_unit', naturalKey: 'sidecar' },
      edgeType: 'deploys',
    });
  });

  it('a deployment unit matching a real component proposes no external component', () => {
    const sources: readonly AcceptedSourceItems[] = [
      {
        sourceKey: 'k8s',
        finalStatus: 'collected',
        items: [
          ...sourcesWithUnit('checkout')[0]!.items,
          {
            kind: 'component_candidate',
            naturalKey: 'checkout',
            name: 'checkout',
            componentType: 'service',
            characteristics: [],
            sourcePaths: [],
            adapterKey: 'k8s',
            adapterVersion: '1.0.0',
          },
        ],
      },
    ];
    const result = buildDraftItems({
      tenantId: 't1',
      runId: 'r1',
      sources,
      adapterConstants,
      snapshot: { nodes: [], edges: [] },
      rejectedDigests: new Set(),
    });
    // The real component + the deployment unit itself — no synthesized external double.
    const addNodes = result.items.filter((i) => i.op === 'add_node');
    expect(addNodes).toHaveLength(2);
    expect(
      addNodes.filter((i) => i.proposed.op === 'add_node' && i.proposed.nodeKind === 'component'),
    ).toHaveLength(1);
    expect(result.items.some((i) => i.op === 'add_edge')).toBe(false);
  });
});
