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
    const now = new Date('2026-01-01T00:05:00.000Z');
    const result = buildDraftItems({
      tenantId: 't1',
      runId: 'r1',
      sources,
      adapterConstants: { otel: { version: '1.0.0', layer: 'runtime', provenance: 'derived_from_trace' } },
      snapshot: { nodes: [], edges: [] },
      rejectedDigests: new Set(),
      now,
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
      adapterConstants: { otel: { version: '1.0.0', layer: 'runtime', provenance: 'derived_from_trace' } },
      snapshot: { nodes: [], edges: [] },
      rejectedDigests: new Set(),
    });
    const addNode = result.items.find((i) => i.op === 'add_node');
    expect(addNode?.confidence).toBe(DEFAULT_CONFIDENCE_CONFIG.base.derived_from_trace);
  });
});
