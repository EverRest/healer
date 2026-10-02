import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import { PrismaDiscoveryRepository, type IngestBatchWriteInput } from '@healer/domain-architecture';
import { TenantContext, scope, withCorrelation } from '@healer/shared';
import { applySqlFile, query, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * Review fix (#7): `ingestBatch`'s idempotency check was `findUniqueOrThrow` + an in-application
 * `finishedAt !== null` branch under READ COMMITTED, with no row lock — two concurrent deliveries
 * of the same run both read `finished_at IS NULL` and both proceed. Fixed with `SELECT ... FOR
 * UPDATE` on the `discovery_run` row. Proven the way 001's own races are (`graph-node-rename-
 * race.e2e.test.ts`, `graph-edge-open-uniqueness.e2e.test.ts`): a held-open transaction, polled
 * through `pg_stat_activity` for a genuine lock wait — never `sleep`.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));
function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-8000-00000000f001';
const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);

describe('PrismaDiscoveryRepository.ingestBatch: concurrent retries of the same run (review fix #7)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let repo: PrismaDiscoveryRepository;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames())
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    await prisma.$connect();
    repo = new PrismaDiscoveryRepository(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  async function seedRun(): Promise<string> {
    const id = randomUUID();
    await prisma.discoveryRun.create({
      data: {
        id,
        tenantId: TENANT_ID,
        baseVersion: 0,
        trigger: 'manual',
        runnerId: 'runner-1',
        startedAt: new Date(),
      },
    });
    return id;
  }

  function minimalInput(runId: string): IngestBatchWriteInput {
    return {
      runId,
      baseVersion: 0,
      outcome: 'complete',
      adapterVersions: {},
      sourceOutcomes: [],
      graphFacts: [],
      collectionGaps: [],
      absenceEvidence: [],
      items: [],
    };
  }

  /** Holds `SELECT ... FOR UPDATE` on the run row, open until `release()` — copied pattern from
   *  `graph-node-rename-race.e2e.test.ts` / `graph-edge-open-uniqueness.e2e.test.ts`. */
  async function holdRunLock(runId: string) {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let ready!: () => void;
    const isReady = new Promise<void>((resolve) => (ready = resolve));
    let pid = 0;
    const done = prisma.$transaction(
      async (tx) => {
        pid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
        await tx.$queryRaw`
          SELECT id FROM "architecture"."discovery_run"
          WHERE id = ${runId}::uuid AND tenant_id = ${TENANT_ID}::uuid
          FOR UPDATE
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

  // Mechanism sanity check: `ingestBatch` genuinely contends for the run row at the Postgres
  // level (proven via `pg_stat_activity`, never `sleep`) rather than only in-process. This alone
  // does not distinguish the fix from its absence — `discoveryRun.update()`, later in the same
  // function, would also collide with this holder's lock even without the `SELECT ... FOR UPDATE`
  // claim at the top, since any transaction holding the lock forces every later write into the
  // same wait. The next test is the one that actually fails without the fix: two *real* concurrent
  // calls, no artificial holder, asserting the single-draft/single-outbox-event outcome directly —
  // this one only establishes that genuine DB-level contention is happening at all.
  it('a concurrent ingestBatch genuinely blocks on the run row at the Postgres level', async () => {
    const runId = await seedRun();
    const holder = await holdRunLock(runId);

    const racer = withCorrelation('corr-race-1', () =>
      repo.ingestBatch(scope(CONTEXT, minimalInput(runId))),
    );
    racer.catch(() => {});

    await waitForBlocked(1, holder);
    await holder.release();

    const result = await racer;
    expect(result).not.toBeNull();
    expect(result!.state).toBe('open');

    const run = await prisma.discoveryRun.findUniqueOrThrow({
      where: { id_tenantId: { id: runId, tenantId: TENANT_ID } },
    });
    expect(run.finishedAt).not.toBeNull();
  });

  it('two real concurrent ingestBatch calls for the same run produce exactly one draft and one outbox event', async () => {
    const runId = await seedRun();
    const input = minimalInput(runId);

    const [first, second] = await Promise.all([
      withCorrelation('corr-race-2a', () => repo.ingestBatch(scope(CONTEXT, input))),
      withCorrelation('corr-race-2b', () => repo.ingestBatch(scope(CONTEXT, input))),
    ]);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.draftId).toBe(second!.draftId);

    const drafts = await prisma.discoveryDraft.findMany({ where: { tenantId: TENANT_ID, runId } });
    expect(drafts).toHaveLength(1);

    const outboxRows = await prisma.outbox.findMany({
      where: { tenantId: TENANT_ID, name: 'DiscoveryDraftProposed', subjectId: drafts[0]!.id },
    });
    expect(outboxRows).toHaveLength(1);
  });

  it('a third, fully sequential retry after completion is still a pure no-op', async () => {
    const runId = await seedRun();
    const input = minimalInput(runId);

    const first = await withCorrelation('corr-race-3a', () =>
      repo.ingestBatch(scope(CONTEXT, input)),
    );
    const outboxBefore = await prisma.outbox.count({ where: { tenantId: TENANT_ID } });

    const second = await withCorrelation('corr-race-3b', () =>
      repo.ingestBatch(scope(CONTEXT, input)),
    );
    expect(second!.draftId).toBe(first!.draftId);

    const outboxAfter = await prisma.outbox.count({ where: { tenantId: TENANT_ID } });
    expect(outboxAfter).toBe(outboxBefore);
  });
});
