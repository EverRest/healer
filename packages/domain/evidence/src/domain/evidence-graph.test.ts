import { describe, expect, it } from 'vitest';
import { buildEvidenceGraph } from './evidence-graph.js';
import type { Evidence, EvidenceLink } from './types.js';

function evidence(
  id: string,
  observedAt: string,
  {
    excerpt,
    ...overrides
  }: Partial<Omit<Evidence, 'excerpt' | 'excerptTruncated'>> & {
    excerpt?: string;
  } = {},
): Evidence {
  return {
    id,
    tenantId: 't1',
    issueId: 'i1',
    type: 'error_signature',
    sourceSystem: 'loki',
    sourceRef: 'q',
    sourceLabel: 'from logs',
    payload: {},
    producedByStep: 'collector',
    refState: 'linked',
    observedAt: new Date(observedAt),
    receivedAt: new Date(observedAt),
    expiresAt: new Date('2027-01-01T00:00:00Z'),
    ...(excerpt === undefined
      ? { excerpt: null, excerptTruncated: false }
      : { excerpt, excerptTruncated: false }),
    ...overrides,
  };
}

function link(id: string, evidenceId: string, conclusionId: string, at: string): EvidenceLink {
  return {
    id,
    tenantId: 't1',
    evidenceId,
    conclusionType: 'diagnosis',
    conclusionId,
    relation: 'supports',
    assertedByStep: 'diagnose',
    assertedAt: new Date(at),
  };
}

describe('buildEvidenceGraph (001 T047, FR-013)', () => {
  it('has one evidence node per record and one conclusion node per distinct conclusion', () => {
    const graph = buildEvidenceGraph(
      [evidence('e1', '2026-01-01T00:00:00Z'), evidence('e2', '2026-01-01T00:00:01Z')],
      [
        link('l1', 'e1', 'c1', '2026-01-02T00:00:00Z'),
        link('l2', 'e2', 'c1', '2026-01-02T00:00:00Z'),
      ],
    );

    expect(graph.nodes.filter((n) => n.kind === 'evidence').map((n) => n.id)).toEqual(['e1', 'e2']);
    expect(graph.nodes.filter((n) => n.kind === 'conclusion').map((n) => n.id)).toEqual(['c1']);
    expect(graph.edges).toHaveLength(2);
  });

  it('keeps evidence that no conclusion cites — a graph of only what was used would hide it', () => {
    const graph = buildEvidenceGraph([evidence('e1', '2026-01-01T00:00:00Z')], []);

    expect(graph.nodes.map((n) => n.id)).toEqual(['e1']);
    expect(graph.edges).toEqual([]);
  });

  it('keeps a detached record as a node, marked detached (R-04)', () => {
    const graph = buildEvidenceGraph(
      [evidence('e1', '2026-01-01T00:00:00Z', { refState: 'detached' })],
      [],
    );

    expect(graph.nodes[0]).toMatchObject({ kind: 'evidence', refState: 'detached' });
  });

  it('is independent of input order — same records, same bytes (SC-005)', () => {
    const e = [evidence('e1', '2026-01-01T00:00:00Z'), evidence('e2', '2026-01-01T00:00:00Z')];
    const l = [
      link('l1', 'e1', 'c1', '2026-01-02T00:00:00Z'),
      link('l2', 'e2', 'c2', '2026-01-02T00:00:00Z'),
    ];

    expect(JSON.stringify(buildEvidenceGraph([...e].reverse(), [...l].reverse()))).toBe(
      JSON.stringify(buildEvidenceGraph(e, l)),
    );
  });

  it('picks the same conclusionType for one conclusionId whatever order links arrive in', () => {
    const asDiagnosis = link('l1', 'e1', 'c1', '2026-01-02T00:00:00Z');
    const asHypothesis: EvidenceLink = {
      ...link('l2', 'e2', 'c1', '2026-01-02T00:00:00Z'),
      conclusionType: 'hypothesis',
    };
    const e = [evidence('e1', '2026-01-01T00:00:00Z'), evidence('e2', '2026-01-01T00:00:00Z')];

    expect(JSON.stringify(buildEvidenceGraph(e, [asDiagnosis, asHypothesis]))).toBe(
      JSON.stringify(buildEvidenceGraph(e, [asHypothesis, asDiagnosis])),
    );
  });

  it('never carries an excerpt or payload — structure only, nothing free-form', () => {
    const graph = buildEvidenceGraph(
      [evidence('e1', '2026-01-01T00:00:00Z', { excerpt: 'customer text', payload: { a: 1 } })],
      [],
    );

    expect(JSON.stringify(graph)).not.toContain('customer text');
  });
});
