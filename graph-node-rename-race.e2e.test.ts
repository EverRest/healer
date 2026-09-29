import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import { GraphConcurrencyError, PrismaGraphNodeRepository } from '@healer/domain-architecture';
import { TenantContext, scope } from '@healer/shared';
import { applySqlFile, query, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * Concurrent rename of the same node (004 T010, R-12): a rename rewrites `natural_key` on the
 * *existing* row, never delete+create. Two backends racing to rewrite the same row's
 * `natural_key` must not both silently win — one succeeds, the other gets `GraphConcurrencyError`
 * and must reread and retry. Held-transaction technique, same as
 * `graph-edge-open-uniqueness.e2e.test.ts` / `issue-deletion.e2e.test.ts`: poll `pg_stat_activity`
 * for a real lock wait rather than sleep.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-8000-00000000a010';
const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);

describe('architecture.graph_node: concurrent rename of the same node (004 T010)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let repo: PrismaGraphNodeRepository;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    await prisma.$connect();
    repo = new PrismaGraphNodeRepository(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  async function seedNode(naturalKey: string): Promise<string> {
    const id = randomUUID();
    await prisma.graphNode.create({
      data: {
        id,
        tenantId: TENANT_ID,
        nodeKind: 'component',
        layer: 'code',
        name: 'n',
        naturalKey,
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

  /** Holds the exact guarded UPDATE the repository issues, open until `release()` (copied
   *  pattern from graph-edge-open-uniqueness.e2e.test.ts / issue-deletion.e2e.test.ts). */
  async function holdRename(id: string, fromKey: string, toKey: string) {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let ready!: () => void;
    const isReady = new Promise<void>((resolve) => (ready = resolve));
    let pid = 0;
    const done = prisma.$transaction(
      async (tx) => {
        pid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
        await tx.$executeRaw`
          UPDATE "architecture"."graph_node"
          SET natural_key = ${toKey}
          WHERE id = ${id}::uuid AND tenant_id = ${TENANT_ID}::uuid AND natural_key = ${fromKey}
        `;
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

  it('rejects the loser of a concurrent rename race with GraphConcurrencyError', async () => {
    const id = await seedNode(`nk-${randomUUID()}`);
    const original = (await prisma.graphNode.findUniqueOrThrow({ where: { id } })).naturalKey;

    const holder = await holdRename(id, original, 'renamed-by-holder');

    // The racer goes through the real repository path — its own read sees `original` (the row
    // holder hasn't committed yet), then its guarded UPDATE blocks on holder's row lock.
    const racer = repo.renameNaturalKey(scope(CONTEXT, { id }), 'renamed-by-racer');
    racer.catch(() => {});

    await waitForBlocked(1, holder);
    await holder.release();

    await expect(racer).rejects.toBeInstanceOf(GraphConcurrencyError);

    const final = await prisma.graphNode.findUniqueOrThrow({ where: { id } });
    expect(final.naturalKey).toBe('renamed-by-holder');
  });

  it('renames the same row in place — same id, no delete+create', async () => {
    const id = await seedNode(`nk-${randomUUID()}`);
    const result = await repo.renameNaturalKey(scope(CONTEXT, { id }), 'renamed');
    expect(result.id).toBe(id);
    const row = await prisma.graphNode.findUniqueOrThrow({ where: { id } });
    expect(row.id).toBe(id);
    expect(row.naturalKey).toBe('renamed');
  });
});
