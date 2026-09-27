import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQueue, deadLetterDepth } from '@healer/workflow';
import { PrismaClient } from '@healer/prisma-client';
import type { SignalJobData } from '@healer/domain-issues';
import {
  applySqlFile,
  query,
  startPostgres,
  startRedis,
  type StartedPostgres,
} from '../../test/containers.js';
import { start } from './src/main.js';

/**
 * The actual consumer (001 T025) — `BullmqSignalQueue`'s own comment named "whatever drains
 * this queue" as not built yet. Proves the whole pipeline end to end: a job on the real
 * `ingestion` BullMQ queue becomes a real `issue` row in Postgres, and a job that can never
 * succeed becomes an observable dead letter rather than disappearing silently (FR-019).
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function signalJob(overrides: Partial<SignalJobData> = {}): SignalJobData {
  return {
    tenantId: '00000000-0000-0000-8000-0000000000d1',
    correlationId: randomUUID(),
    signal: {
      observedAt: '2026-01-01T00:00:00.000Z',
      component: 'checkout-service',
      environment: 'prod',
      errorSignature: { exceptionType: 'WorkerE2eCase' },
    },
    ...overrides,
  };
}

describe('apps/worker consuming the ingestion queue (001 T025, FR-019)', () => {
  let pg: StartedPostgres;
  let redis: Awaited<ReturnType<typeof startRedis>>;
  let prisma: PrismaClient;
  let handle: { close: () => Promise<void> };

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    await query(
      pg,
      `insert into "issue"."normalisation_ruleset" (version, rules) values (1, '{"stripPatterns":[]}')`,
    );
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    redis = await startRedis();

    process.env.DATABASE_URL = pg.url;
    process.env.REDIS_URL = redis.url;
    handle = start();
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    await prisma?.$disconnect();
    await redis?.stop();
    await pg?.stop();
  });

  it('a job on the ingestion queue becomes a real issue row, and completes rather than retrying', async () => {
    const queue = createQueue('ingestion', { url: redis.url });
    try {
      const job = signalJob();
      const added = await queue.add('signal', job);

      // Polls Postgres rather than a BullMQ 'completed' event: the worker process under test
      // is this same process (`start()` above), and asserting against the actual persisted
      // effect is what the pipeline is for — a queue event only proves the job ran, not that it
      // did the right thing.
      const fingerprint = await waitFor(async () => {
        const rows = await prisma.issue.findMany({ where: { tenantId: job.tenantId } });
        return rows[0]?.fingerprint ?? null;
      });
      expect(fingerprint).not.toBeNull();

      // Real bug this once caught (review finding): the handler returned the full `Issue`
      // (carrying `occurrenceCount: bigint`), and BullMQ's own `JSON.stringify` of a job's return
      // value throws on a bigint — reporting a *successful* ingest as a failed job and retrying
      // it, which would attach the same signal a second time and inflate the count. Waiting past
      // where a retry would have landed and re-checking is what would have caught it: a bug that
      // only shows up on the *second* attempt is invisible right after the first one succeeds.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(await added.getState()).toBe('completed');

      const issues = await prisma.issue.findMany({ where: { tenantId: job.tenantId } });
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ environment: 'prod', occurrenceCount: 1n });
    } finally {
      await queue.close();
    }
  }, 30_000);

  it('a job that can never succeed becomes an observable dead letter, not a silent loss', async () => {
    const queue = createQueue('ingestion', { url: redis.url });
    try {
      // Not a valid uuid — TenantContext.forTrustedInternalUse throws every attempt, so this
      // can never succeed regardless of retry. `attempts: 1` (overriding the class default of
      // 5) keeps the test fast without changing what it proves: the failure is retained and
      // counted, not silently dropped.
      const job = signalJob({ tenantId: 'not-a-valid-tenant-id' });
      await queue.add('signal', job, { attempts: 1 });

      const before = await deadLetterDepth(queue);
      const after = await waitFor(async () => {
        const count = await deadLetterDepth(queue);
        return count > before ? count : null;
      });
      expect(after).toBeGreaterThan(before);
    } finally {
      await queue.close();
    }
  }, 30_000);
});

/** Polls `check` until it returns a non-null value, or throws after the budget. */
async function waitFor<T>(check: () => Promise<T | null>, timeoutMs = 15_000): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const result = await check();
    if (result !== null) return result;
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
