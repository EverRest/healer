import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import {
  InvalidEdgeObservationError,
  ObservationReplayMismatchError,
  PROVENANCE_STRENGTH_V1,
  PrismaEdgeProvenanceRepository,
  type EdgeObservation,
  type MachineProvenanceClass,
} from '@healer/domain-architecture';
import { TenantContext, scope } from '@healer/shared';
import { applySqlFile, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * 004 US2: the merge path over `edge_provenance` (T036 ordering by the stored ordinal, T037 one
 * edge / both provenances retained / the strongest's confidence, T038 replay + denormalised
 * counters). Quickstart 4 and 5.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-8000-00000000a036';
const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);
const NOW = new Date('2026-10-02T12:00:00Z');

describe('edge provenance merge (004 T036-T038)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let repo: PrismaEdgeProvenanceRepository;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    await prisma.$connect();
    repo = new PrismaEdgeProvenanceRepository(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  async function seedNode(): Promise<string> {
    const id = randomUUID();
    await prisma.graphNode.create({
      data: {
        id,
        tenantId: TENANT_ID,
        nodeKind: 'component',
        layer: 'code',
        name: 'n',
        naturalKey: `nk-${id}`,
        provenance: 'derived_from_code',
        strength: 30,
        confidence: 50,
        state: 'proposed',
        validFromVersion: 1,
        observationRef: randomUUID(),
      },
    });
    return id;
  }

  function observation(
    from: string,
    to: string,
    provenance: MachineProvenanceClass,
    overrides: Partial<EdgeObservation> = {},
  ): EdgeObservation {
    return {
      fromNodeId: from,
      toNodeId: to,
      edgeType: 'depends_on',
      layer: 'code',
      provenance,
      observationRef: randomUUID(),
      adapterKey: `adapter-${provenance}`,
      adapterVersion: '1.0.0',
      observationCount: 120,
      lastObservedAt: NOW,
      observedUntil: NOW,
      baseVersion: 1,
      ...overrides,
    };
  }

  const merge = (o: EdgeObservation) => repo.mergeObservation(scope(CONTEXT, o));

  it('T036: a trace-derived edge outranks a folder-inferred one by the STORED ordinal', async () => {
    const [a, b, c] = [await seedNode(), await seedNode(), await seedNode()];
    const traced = await merge(observation(a, b, 'derived_from_trace'));
    const inferred = await merge(observation(a, c, 'inferred_from_convention'));

    const rows = await prisma.graphEdge.findMany({
      where: { tenantId: TENANT_ID, id: { in: [traced.edgeId, inferred.edgeId] } },
      orderBy: { strength: 'desc' },
    });
    // Ordering comes from the column written at insert — no ordinal is derived on this read path.
    expect(rows.map((r) => r.id)).toEqual([traced.edgeId, inferred.edgeId]);
    expect(rows.map((r) => r.strength)).toEqual([
      PROVENANCE_STRENGTH_V1.derived_from_trace,
      PROVENANCE_STRENGTH_V1.inferred_from_convention,
    ]);
  });

  it('T037: the same edge from traces and from AST is ONE edge, both provenances kept, strongest wins', async () => {
    const [a, b] = [await seedNode(), await seedNode()];
    const ast = await merge(observation(a, b, 'derived_from_code', { observationCount: 5 }));
    const trace = await merge(observation(a, b, 'derived_from_trace', { observationCount: 200 }));

    expect(trace.edgeId).toBe(ast.edgeId);
    expect(ast.created).toBe(true);
    expect(trace.created).toBe(false);
    expect(
      await prisma.graphEdge.count({ where: { tenantId: TENANT_ID, fromNodeId: a, toNodeId: b } }),
    ).toBe(1);

    const provenance = await prisma.edgeProvenance.findMany({
      where: { tenantId: TENANT_ID, edgeId: ast.edgeId },
      orderBy: { strength: 'asc' },
    });
    expect(provenance.map((p) => p.provenance)).toEqual([
      'derived_from_code',
      'derived_from_trace',
    ]);
    expect(provenance.every((p) => p.observationRef !== null)).toBe(true);

    const edge = await prisma.graphEdge.findUniqueOrThrow({ where: { id: ast.edgeId } });
    expect(edge.strength).toBe(Math.max(...provenance.map((p) => p.strength)));
    expect(edge.confidence).toBe(Math.max(...provenance.map((p) => p.confidence)));
    expect(edge.provenance).toBe('derived_from_trace');
    expect(Number(edge.observationCount)).toBe(205);
  });

  it('a weaker source arriving later never lowers the edge', async () => {
    const [a, b] = [await seedNode(), await seedNode()];
    const first = await merge(observation(a, b, 'derived_from_trace'));
    await merge(observation(a, b, 'inferred_from_convention', { observationCount: 1 }));
    const edge = await prisma.graphEdge.findUniqueOrThrow({ where: { id: first.edgeId } });
    expect(edge.strength).toBe(PROVENANCE_STRENGTH_V1.derived_from_trace);
    expect(edge.provenance).toBe('derived_from_trace');
  });

  it('replaying the same observation changes nothing (jobs may run twice)', async () => {
    const [a, b] = [await seedNode(), await seedNode()];
    const o = observation(a, b, 'derived_from_trace');
    const first = await merge(o);
    const again = await merge(o);
    expect(again).toEqual({ edgeId: first.edgeId, created: false, recorded: false });
    expect(await prisma.edgeProvenance.count({ where: { edgeId: first.edgeId } })).toBe(1);
    const edge = await prisma.graphEdge.findUniqueOrThrow({ where: { id: first.edgeId } });
    expect(Number(edge.observationCount)).toBe(120);
  });

  it("confidence configuration is per tenant: one tenant's override never reaches another", async () => {
    const OTHER = '00000000-0000-0000-8000-00000000b036';
    await prisma.confidenceConfig.create({
      data: { tenantId: OTHER, config: { base: { derived_from_trace: 10 } } },
    });
    const nodeFor = async (tenantId: string) => {
      const id = randomUUID();
      await prisma.graphNode.create({
        data: {
          id,
          tenantId,
          nodeKind: 'component',
          layer: 'code',
          name: 'n',
          naturalKey: id,
          provenance: 'derived_from_code',
          strength: 30,
          confidence: 50,
          state: 'proposed',
          validFromVersion: 1,
          observationRef: randomUUID(),
        },
      });
      return id;
    };
    const mergeFor = async (tenantId: string) => {
      const o = observation(
        await nodeFor(tenantId),
        await nodeFor(tenantId),
        'derived_from_trace',
        {
          observationCount: 2,
        },
      );
      const merged = await repo.mergeObservation(
        scope(TenantContext.forTrustedInternalUse(tenantId), o),
      );
      return (await prisma.graphEdge.findUniqueOrThrow({ where: { id: merged.edgeId } }))
        .confidence;
    };
    expect(await mergeFor(OTHER)).toBe(10 + 4);
    expect(await mergeFor(TENANT_ID)).toBe(70 + 4);
  });

  it('a new edge is proposed and carries a derived (not self-reported) confidence', async () => {
    const [a, b] = [await seedNode(), await seedNode()];
    const single = await merge(observation(a, b, 'derived_from_trace', { observationCount: 1 }));
    const edge = await prisma.graphEdge.findUniqueOrThrow({ where: { id: single.edgeId } });
    expect(edge.state).toBe('proposed');
    expect(edge.validFromVersion).toBe(1);
    expect(edge.confidence).toBeLessThanOrEqual(40); // one observation is not a fact
  });

  it('confidence follows the EDGE aggregate: 50 separate single observations are not 50 facts of one', async () => {
    const [a, b] = [await seedNode(), await seedNode()];
    let edgeId = '';
    for (let i = 0; i < 50; i += 1) {
      edgeId = (await merge(observation(a, b, 'derived_from_trace', { observationCount: 1 })))
        .edgeId;
    }
    const edge = await prisma.graphEdge.findUniqueOrThrow({ where: { id: edgeId } });
    expect(Number(edge.observationCount)).toBe(50);
    expect(edge.confidence).toBeGreaterThan(40); // singleObservationCap
    const rows = await prisma.edgeProvenance.findMany({ where: { edgeId } });
    expect(rows.reduce((sum, r) => sum + Number(r.observationCount), 0)).toBe(50);
    expect(rows.every((r) => r.lastObservedAt?.getTime() === NOW.getTime())).toBe(true);
  });

  it('the reference instant is part of the input: the same observation stores the same confidence on retry, and a later window is staler', async () => {
    const [a, b, c] = [await seedNode(), await seedNode(), await seedNode()];
    const o = (to: string, observedUntil: Date) =>
      observation(a, to, 'derived_from_trace', { observationCount: 50, observedUntil });
    const first = await merge(o(b, NOW));
    const retry = await merge(o(c, NOW));
    const stale = await merge(
      observation(c, b, 'derived_from_trace', {
        observationCount: 50,
        observedUntil: new Date(NOW.getTime() + 120 * 86_400_000),
      }),
    );
    const conf = async (id: string) =>
      (await prisma.graphEdge.findUniqueOrThrow({ where: { id } })).confidence;
    expect(await conf(retry.edgeId)).toBe(await conf(first.edgeId));
    expect(await conf(stale.edgeId)).toBeLessThan(await conf(first.edgeId));
  });

  it.each([
    ['zero count', { observationCount: 0 }],
    ['negative count', { observationCount: -1 }],
    ['NaN count', { observationCount: Number.NaN }],
    ['invalid Date', { lastObservedAt: new Date('nope') }],
    ['an instant after the window', { lastObservedAt: new Date(NOW.getTime() + 3_600_000) }],
  ])('rejects %s and stores nothing', async (_name, over) => {
    const [a, b] = [await seedNode(), await seedNode()];
    await expect(merge(observation(a, b, 'derived_from_trace', over))).rejects.toBeInstanceOf(
      InvalidEdgeObservationError,
    );
    expect(await prisma.graphEdge.count({ where: { fromNodeId: a } })).toBe(0);
  });

  it('a replayed observation_ref with different content is refused, not silently dropped', async () => {
    const [a, b] = [await seedNode(), await seedNode()];
    const o = observation(a, b, 'derived_from_trace');
    await merge(o);
    await expect(merge({ ...o, adapterKey: 'someone-else' })).rejects.toBeInstanceOf(
      ObservationReplayMismatchError,
    );
    await expect(merge({ ...o, provenance: 'derived_from_code' })).rejects.toBeInstanceOf(
      ObservationReplayMismatchError,
    );
    await expect(merge({ ...o, discoveryRunId: randomUUID() })).rejects.toBeInstanceOf(
      ObservationReplayMismatchError,
    );
    // a different confidence-relevant value is NOT a mismatch: confidence is derived, not content
    await expect(merge({ ...o, observationCount: 999 })).resolves.toMatchObject({
      recorded: false,
    });
  });

  it('a bad tenant confidence override fails loudly and names the tenant', async () => {
    const tenantId = '00000000-0000-0000-8000-00000000c036';
    await prisma.confidenceConfig.create({ data: { tenantId, config: { base: 5 } } });
    const id = async () => {
      const n = randomUUID();
      await prisma.graphNode.create({
        data: {
          id: n,
          tenantId,
          nodeKind: 'component',
          layer: 'code',
          name: 'n',
          naturalKey: n,
          provenance: 'derived_from_code',
          strength: 30,
          confidence: 50,
          state: 'proposed',
          validFromVersion: 1,
          observationRef: randomUUID(),
        },
      });
      return n;
    };
    const o = observation(await id(), await id(), 'derived_from_trace');
    await expect(
      repo.mergeObservation(scope(TenantContext.forTrustedInternalUse(tenantId), o)),
    ).rejects.toThrow(new RegExp(tenantId));
  });
});
