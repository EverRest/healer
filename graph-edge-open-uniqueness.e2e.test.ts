import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, PrismaClient } from '@healer/prisma-client';
import { applySqlFile, query, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * At most one open row per logical edge (004 T009, data-model.md graph_edge "Indexes"): a
 * partial unique index on `(tenant_id, from_node_id, to_node_id, edge_type, layer) where
 * valid_to_version = 2147483647`. Proven with two backends racing a real concurrent INSERT, not
 * a single-connection check-then-insert — the 001-era lesson (this repo's own scars) is that a
 * sequential happy-path insert proves nothing about the concurrent case. Technique copied from
 * `issue-deletion.e2e.test.ts`'s `hold`/`waitForBlocked` (canonical, more-refined than
 * `issue-merge.e2e.test.ts`'s earlier version): poll `pg_stat_activity` for a real lock wait
 * rather than sleep.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-0000-00000000a009';

describe('architecture.graph_edge: at most one open row per logical edge (004 T009)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    await prisma.$connect();
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  async function seedNodes(): Promise<{ fromId: string; toId: string }> {
    const fromId = randomUUID();
    const toId = randomUUID();
    for (const id of [fromId, toId]) {
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
    }
    return { fromId, toId };
  }

  function newOpenEdge(id: string, fromId: string, toId: string) {
    return {
      id,
      tenantId: TENANT_ID,
      fromNodeId: fromId,
      toNodeId: toId,
      edgeType: 'depends_on' as const,
      layer: 'code' as const,
      provenance: 'derived_from_code' as const,
      strength: 30,
      confidence: 50,
      state: 'proposed' as const,
      validFromVersion: 1,
      // validToVersion defaults to 2147483647 (open) — both racers stay open.
    };
  }

  /**
   * Holds a transaction open (after `work`, then `after` once released) — what makes a race
   * observable. `pid` is the holder's backend, so `waitForBlocked` can ask about waiters that
   * started after *this* holder rather than any waiter in the database (copied from
   * `issue-deletion.e2e.test.ts`).
   */
  async function hold(
    work: (tx: Prisma.TransactionClient) => Promise<void>,
    after?: (tx: Prisma.TransactionClient) => Promise<void>,
  ) {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let ready!: () => void;
    const isReady = new Promise<void>((resolve) => (ready = resolve));
    let pid = 0;
    const done = prisma.$transaction(
      async (tx) => {
        pid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
        await work(tx);
        ready();
        await gate;
        await after?.(tx);
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

  /**
   * Waits until at least `wanted` backends are waiting on a lock **and began that wait after
   * `holder` opened its transaction** (copied from `issue-deletion.e2e.test.ts`).
   */
  async function waitForBlocked(wanted: number, holder: { pid: number }): Promise<void> {
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
      if (waiting >= wanted) return;
      if (Date.now() > deadline) {
        throw new Error(`expected ${wanted} blocked backend(s), saw ${waiting} — nothing waited`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it('rejects a concurrent second open row for the same logical edge', async () => {
    const { fromId, toId } = await seedNodes();
    const firstId = randomUUID();
    const secondId = randomUUID();

    const holder = await hold(async (tx) => {
      await tx.graphEdge.create({ data: newOpenEdge(firstId, fromId, toId) });
    });

    const racer = prisma.graphEdge.create({ data: newOpenEdge(secondId, fromId, toId) });
    racer.catch(() => {}); // observed via the assertion below; avoid an unhandled rejection log

    await waitForBlocked(1, holder);
    await holder.release();

    await expect(racer).rejects.toThrow();
    const openCount = await prisma.graphEdge.count({
      where: { tenantId: TENANT_ID, fromNodeId: fromId, toNodeId: toId, validToVersion: 2147483647 },
    });
    expect(openCount).toBe(1);
  });

  it('allows a second open row once the first is superseded (valid_to_version closed)', async () => {
    const { fromId, toId } = await seedNodes();
    const firstId = randomUUID();
    const secondId = randomUUID();
    await prisma.graphEdge.create({ data: newOpenEdge(firstId, fromId, toId) });
    await prisma.graphEdge.update({
      where: { id_tenantId: { id: firstId, tenantId: TENANT_ID } },
      data: { validToVersion: 2 },
    });

    await expect(
      prisma.graphEdge.create({ data: newOpenEdge(secondId, fromId, toId) }),
    ).resolves.toBeDefined();
  });
});
