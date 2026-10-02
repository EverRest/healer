import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import {
  PROVENANCE_STRENGTH_V1,
  PrismaEdgeProvenanceRepository,
} from '@healer/domain-architecture';
import { TenantContext, scope } from '@healer/shared';
import { applySqlFile, query, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * 004 T038: two writers merging observations into ONE edge. `graph_edge.strength` is the maximum
 * over `edge_provenance`, kept by a trigger that computes MAX() from its statement's snapshot. A
 * read-committed merge with no row lock computes that MAX without the other writer's uncommitted
 * row, and the later writer LOWERS the edge — silently, no error. The merge therefore locks the
 * edge row first.
 *
 * The race is held open and observed, never slept through: the holder inserts a strong (trace)
 * provenance row and keeps its transaction open; the racer then merges a weaker (runtime) one and
 * we poll `pg_stat_activity` for a real lock wait before letting the holder commit.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-8000-00000000a038';
const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);
const NOW = new Date('2026-10-02T12:00:00Z');

describe('edge provenance merge: concurrent writers to one edge (004 T038)', () => {
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

  /** A writer that has inserted its provenance row (the trigger has therefore taken the edge
   *  row's lock) and stays open until `release()`. */
  async function holdTraceWriter(edgeId: string) {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let ready!: () => void;
    const isReady = new Promise<void>((resolve) => (ready = resolve));
    let pid = 0;
    const done = prisma.$transaction(
      async (tx) => {
        pid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
        await tx.$executeRaw`
          INSERT INTO "architecture"."edge_provenance"
            (id, tenant_id, edge_id, provenance, strength, confidence, observation_ref,
             adapter_key, adapter_version)
          VALUES (${randomUUID()}::uuid, ${TENANT_ID}::uuid, ${edgeId}::uuid, 'derived_from_trace',
                  ${PROVENANCE_STRENGTH_V1.derived_from_trace}, 90, ${randomUUID()}::uuid,
                  'holder', '1')`;
        ready();
        await gate;
      },
      { timeout: 120_000, maxWait: 60_000 },
    );
    done.catch(() => ready());
    await isReady;
    return {
      pid,
      release: async () => {
        open();
        await done;
      },
    };
  }

  async function waitForBlocked(holder: { pid: number }): Promise<void> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const waiting = Number(
        await query(
          pg,
          `select count(*) from pg_stat_activity w
           where w.datname = current_database() and w.wait_event_type = 'Lock'
             and w.pid <> ${holder.pid}
             and w.query_start >= (select h.xact_start from pg_stat_activity h where h.pid = ${holder.pid})`,
        ),
      );
      if (waiting >= 1) return;
      if (Date.now() > deadline) throw new Error('the racer never waited on the holder');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it(
    'a weaker observation merged during a stronger writer’s open transaction cannot lower the edge',
    { repeats: 9 },
    async () => {
      const [a, b] = [await seedNode(), await seedNode()];
      const seeded = await repo.mergeObservation(
        scope(CONTEXT, {
          fromNodeId: a,
          toNodeId: b,
          edgeType: 'depends_on',
          layer: 'code' as const,
          provenance: 'derived_from_code' as const,
          observationRef: randomUUID(),
          adapterKey: 'ast',
          adapterVersion: '1',
          observationCount: 10,
          lastObservedAt: NOW,
          observedUntil: NOW,
          baseVersion: 1,
        }),
      );

      const holder = await holdTraceWriter(seeded.edgeId);
      const racer = repo.mergeObservation(
        scope(CONTEXT, {
          fromNodeId: a,
          toNodeId: b,
          edgeType: 'depends_on',
          layer: 'code' as const,
          provenance: 'derived_from_runtime' as const,
          observationRef: randomUUID(),
          adapterKey: 'k8s',
          adapterVersion: '1',
          observationCount: 10,
          lastObservedAt: NOW,
          observedUntil: NOW,
          baseVersion: 1,
        }),
      );
      racer.catch(() => {});

      await waitForBlocked(holder);
      await holder.release();
      await racer;

      const edge = await prisma.graphEdge.findUniqueOrThrow({ where: { id: seeded.edgeId } });
      const rows = await prisma.edgeProvenance.findMany({ where: { edgeId: seeded.edgeId } });
      expect(rows).toHaveLength(3);
      expect(edge.strength).toBe(PROVENANCE_STRENGTH_V1.derived_from_trace);
      expect(edge.confidence).toBe(Math.max(...rows.map((r) => r.confidence)));
    },
  );

  /** A writer that founded the edge (uncommitted) and stays open until `release()`. */
  async function holdFounder(a: string, b: string) {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let ready!: () => void;
    const isReady = new Promise<void>((resolve) => (ready = resolve));
    let pid = 0;
    const done = prisma.$transaction(
      async (tx) => {
        pid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
        await tx.$executeRaw`
          INSERT INTO "architecture"."graph_edge"
            (id, tenant_id, from_node_id, to_node_id, edge_type, layer, provenance, strength,
             confidence, state, valid_from_version)
          VALUES (${randomUUID()}::uuid, ${TENANT_ID}::uuid, ${a}::uuid, ${b}::uuid, 'depends_on',
                  'code', 'derived_from_code', 30, 50, 'proposed', 1)`;
        ready();
        await gate;
      },
      { timeout: 120_000, maxWait: 60_000 },
    );
    done.catch(() => ready());
    await isReady;
    return {
      pid,
      release: async () => {
        open();
        await done;
      },
    };
  }

  it(
    'the loser of a founding race reports created=false and still records its observation',
    { repeats: 4 },
    async () => {
      const [a, b] = [await seedNode(), await seedNode()];
      const holder = await holdFounder(a, b);
      const racer = repo.mergeObservation(
        scope(CONTEXT, {
          fromNodeId: a,
          toNodeId: b,
          edgeType: 'depends_on',
          layer: 'code' as const,
          provenance: 'derived_from_trace' as const,
          observationRef: randomUUID(),
          adapterKey: 'otel',
          adapterVersion: '1',
          observationCount: 5,
          lastObservedAt: NOW,
          observedUntil: NOW,
          baseVersion: 1,
        }),
      );
      racer.catch(() => {});
      await waitForBlocked(holder);
      await holder.release();
      const result = await racer;
      expect(result.created).toBe(false);
      expect(result.recorded).toBe(true);
      expect(await prisma.graphEdge.count({ where: { fromNodeId: a, toNodeId: b } })).toBe(1);
      expect(await prisma.edgeProvenance.count({ where: { edgeId: result.edgeId } })).toBe(1);
    },
  );
});
