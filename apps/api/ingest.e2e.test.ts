import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQueue } from '@healer/workflow';
import {
  BullmqSignalQueue,
  PrismaAuditRepository,
  PrismaIngestionDeliveryRepository,
  PrismaIssueRepository,
  type AuditRepository,
  type IngestionDeliveryRepository,
  type IssueRepository,
} from '@healer/domain-issues';
import { PrismaEvidenceRepository, type EvidenceRepository } from '@healer/domain-evidence';
import { PrismaClient } from '@healer/prisma-client';
import { assertTenantScopedEnqueue } from '../../test/tenant-isolation.js';
import {
  applySqlFile,
  startPostgres,
  startRedis,
  type StartedPostgres,
} from '../../test/containers.js';
import { configureApiPrefix, configureIngestBodyLimit, createApiModule } from './src/main.js';

/**
 * Boots a real Redis (first consumer of `startRedis`, 012 T003), a real Postgres (for the
 * `X-Delivery-Id` idempotency check, 001 T020/T021) and a real Nest HTTP server to prove
 * `POST /ingest/signals` actually enqueues (001 T019, FR-019) — a unit test with fakes cannot
 * prove the BullMQ/Prisma wiring itself works. Lives beside `src/`, not inside it:
 * `apps/api/tsconfig.json`'s `rootDir` is `src`, and its own project cannot reach outside that to
 * `test/containers.ts`; sitting outside `include` keeps it out of that project's file list, the
 * same way every other DB/Redis-backed e2e test at the repo root is outside any tsc project.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

describe('POST /ingest/signals (001 T019/T020/T021, FR-004, FR-019)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let redis: Awaited<ReturnType<typeof startRedis>>;
  let app: NestExpressApplication;

  const validSignal = () => ({
    observedAt: '2026-01-01T00:00:00.000Z',
    component: 'checkout-api',
    environment: 'prod',
    errorSignature: { exceptionType: 'TimeoutError' },
  });

  /** Every test below uses its own delivery id unless it deliberately reuses one. */
  const post = (tenantId: string, body: unknown, deliveryId = randomUUID()) =>
    request(app.getHttpServer())
      .post('/api/v1/ingest/signals')
      .set('X-Tenant-Id', tenantId)
      .set('X-Delivery-Id', deliveryId)
      .set('X-Provider-Id', 'sentry')
      .send(body);

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    redis = await startRedis();
    const queue = new BullmqSignalQueue({ url: redis.url });
    const deliveries = new PrismaIngestionDeliveryRepository(prisma);
    const ApiModule = createApiModule(
      { service: 'healer-api', version: 'test', build: 'test', runnerProtocolVersion: 1 },
      queue,
      deliveries,
      new PrismaIssueRepository(prisma),
      new PrismaEvidenceRepository(prisma),
      new PrismaAuditRepository(prisma),
    );
    app = await NestFactory.create<NestExpressApplication>(ApiModule, { logger: false });
    configureApiPrefix(app);
    configureIngestBodyLimit(app);
    await app.init();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await redis?.stop();
    await pg?.stop();
  });

  it('accepts a batch, returns 202 with the accepted count, and enqueues one job per signal', async () => {
    const tenantId = '00000000-0000-0000-8000-0000000000a1';
    const response = await post(tenantId, { signals: [validSignal(), validSignal()] }).expect(202);

    expect(response.body).toEqual({ accepted: 2, duplicate: false });

    const inspectQueue = createQueue('ingestion', { url: redis.url });
    try {
      const jobs = await inspectQueue.getJobs(['waiting', 'delayed', 'active']);
      const own = jobs.filter((job) => job.data.tenantId === tenantId);
      expect(own).toHaveLength(2);
      // BullMQ JSON-serializes job data — observedAt must survive as a string, not a Date.
      expect(own[0]?.data.signal).toMatchObject({
        component: 'checkout-api',
        observedAt: '2026-01-01T00:00:00.000Z',
      });
    } finally {
      await inspectQueue.close();
    }
  });

  it("scopes the enqueued job to the caller's tenant header, never mixing tenants", async () => {
    const inspectQueue = createQueue('ingestion', { url: redis.url });
    try {
      await assertTenantScopedEnqueue(app, 'POST', '/api/v1/ingest/signals', {
        tenantA: '00000000-0000-0000-8000-0000000000a2',
        tenantB: '00000000-0000-0000-8000-0000000000a3',
        tenantHeader: 'X-Tenant-Id',
        expectStatus: 202,
        bodyFor: (marker) => ({ signals: [{ ...validSignal(), component: marker }] }),
        headersFor: (marker) => ({ 'X-Delivery-Id': marker, 'X-Provider-Id': 'sentry' }),
        tenantIdFor: async (marker) => {
          const jobs = await inspectQueue.getJobs(['waiting', 'delayed', 'active']);
          return jobs.find((job) => job.data.signal.component === marker)?.data.tenantId;
        },
      });
    } finally {
      await inspectQueue.close();
    }
  });

  it('enqueues every job in a batch under one shared correlation id', async () => {
    const tenantId = '00000000-0000-0000-8000-0000000000a6';
    await post(tenantId, { signals: [validSignal(), validSignal(), validSignal()] }).expect(202);

    const inspectQueue = createQueue('ingestion', { url: redis.url });
    try {
      const jobs = await inspectQueue.getJobs(['waiting', 'delayed', 'active']);
      const own = jobs.filter((job) => job.data.tenantId === tenantId);
      expect(own).toHaveLength(3);
      const correlationIds = new Set(own.map((job) => job.data.correlationId));
      expect(correlationIds.size).toBe(1);
    } finally {
      await inspectQueue.close();
    }
  });

  it('accepts a timezone-offset observedAt, not only a bare Z suffix', async () => {
    const tenantId = '00000000-0000-0000-8000-0000000000a7';
    await post(tenantId, {
      signals: [{ ...validSignal(), observedAt: '2026-01-01T02:00:00+02:00' }],
    }).expect(202);
  });

  it('accepts a signal carrying an unrecognized field, dropping it rather than rejecting the batch', async () => {
    const tenantId = '00000000-0000-0000-8000-0000000000a8';
    await post(tenantId, {
      signals: [{ ...validSignal(), newProviderField: 'unrecognized-but-forward-compatible' }],
    }).expect(202);
  });

  it('rejects a request with no X-Tenant-Id header', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/ingest/signals')
      .set('X-Delivery-Id', randomUUID())
      .set('X-Provider-Id', 'sentry')
      .send({ signals: [validSignal()] })
      .expect(400);
  });

  it('rejects a request with no X-Delivery-Id header', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/ingest/signals')
      .set('X-Tenant-Id', '00000000-0000-0000-8000-0000000000aa')
      .set('X-Provider-Id', 'sentry')
      .send({ signals: [validSignal()] })
      .expect(400);
  });

  it('rejects a request with no X-Provider-Id header', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/ingest/signals')
      .set('X-Tenant-Id', '00000000-0000-0000-8000-0000000000ab')
      .set('X-Delivery-Id', randomUUID())
      .send({ signals: [validSignal()] })
      .expect(400);
  });

  it('rejects a batch over the 1000-item cap without enqueuing anything', async () => {
    const tenantId = '00000000-0000-0000-8000-0000000000a4';
    const signals = Array.from({ length: 1001 }, validSignal);
    await post(tenantId, { signals }).expect(400);

    const inspectQueue = createQueue('ingestion', { url: redis.url });
    try {
      const jobs = await inspectQueue.getJobs(['waiting', 'delayed', 'active']);
      expect(jobs.filter((job) => job.data.tenantId === tenantId)).toHaveLength(0);
    } finally {
      await inspectQueue.close();
    }
  });

  it('a signal missing a required field is rejected per-item, not the whole request (001 T024, quickstart 20)', async () => {
    const response = await post('00000000-0000-0000-8000-0000000000a5', {
      signals: [{ observedAt: '2026-01-01T00:00:00.000Z', component: 'x' }],
    }).expect(202);

    expect(response.body.accepted).toBe(0);
    expect(response.body.rejected).toHaveLength(1);
    expect(response.body.rejected[0].index).toBe(0);
  });

  it('a batch mixing valid and malformed signals accepts and enqueues the valid ones, rejecting only the bad one', async () => {
    const tenantId = '00000000-0000-0000-8000-0000000000ae';
    const response = await post(tenantId, {
      signals: [
        validSignal(),
        { observedAt: '2026-01-01T00:00:00.000Z', component: 'x' }, // missing environment/errorSignature
        validSignal(),
      ],
    }).expect(202);

    expect(response.body.accepted).toBe(2);
    expect(response.body.rejected).toEqual([{ index: 1, error: expect.any(String) }]);

    const inspectQueue = createQueue('ingestion', { url: redis.url });
    try {
      const jobs = await inspectQueue.getJobs(['waiting', 'delayed', 'active']);
      expect(jobs.filter((job) => job.data.tenantId === tenantId)).toHaveLength(2);
    } finally {
      await inspectQueue.close();
    }
  });

  it('a wrongly typed but non-identity errorSignature field is dropped, not fatal — "issue created from what parsed"', async () => {
    const tenantId = '00000000-0000-0000-8000-0000000000af';
    const response = await post(tenantId, {
      signals: [
        {
          ...validSignal(),
          errorSignature: { exceptionType: 'RealException', frames: 'not-an-array' },
        },
      ],
    }).expect(202);

    expect(response.body).toEqual({ accepted: 1, duplicate: false });
    const inspectQueue = createQueue('ingestion', { url: redis.url });
    try {
      const jobs = await inspectQueue.getJobs(['waiting', 'delayed', 'active']);
      const own = jobs.filter((job) => job.data.tenantId === tenantId);
      expect(own).toHaveLength(1);
      expect(own[0]?.data.signal.errorSignature).toEqual({ exceptionType: 'RealException' });
    } finally {
      await inspectQueue.close();
    }
  });

  it('the same delivery posted twice returns duplicate: true, counts unchanged, and enqueues nothing the second time (001 T020, quickstart 4)', async () => {
    const tenantId = '00000000-0000-0000-8000-0000000000ac';
    const deliveryId = randomUUID();
    const signals = [validSignal(), validSignal(), validSignal()];

    const first = await post(tenantId, { signals }, deliveryId).expect(202);
    expect(first.body).toEqual({ accepted: 3, duplicate: false });

    const second = await post(tenantId, { signals }, deliveryId).expect(202);
    expect(second.body).toEqual({ accepted: 3, duplicate: true });

    const inspectQueue = createQueue('ingestion', { url: redis.url });
    try {
      const jobs = await inspectQueue.getJobs(['waiting', 'delayed', 'active']);
      expect(jobs.filter((job) => job.data.tenantId === tenantId)).toHaveLength(3);
    } finally {
      await inspectQueue.close();
    }
  });

  it('the same delivery id from two different providers is not treated as a duplicate', async () => {
    const tenantId = '00000000-0000-0000-8000-0000000000ad';
    const deliveryId = randomUUID();

    const first = await request(app.getHttpServer())
      .post('/api/v1/ingest/signals')
      .set('X-Tenant-Id', tenantId)
      .set('X-Delivery-Id', deliveryId)
      .set('X-Provider-Id', 'sentry')
      .send({ signals: [validSignal()] })
      .expect(202);
    const second = await request(app.getHttpServer())
      .post('/api/v1/ingest/signals')
      .set('X-Tenant-Id', tenantId)
      .set('X-Delivery-Id', deliveryId)
      .set('X-Provider-Id', 'datadog')
      .send({ signals: [validSignal()] })
      .expect(202);

    expect(first.body).toEqual({ accepted: 1, duplicate: false });
    expect(second.body).toEqual({ accepted: 1, duplicate: false });
  });
});

/**
 * A separate app instance pointed at an unreachable Redis (001 T019 review): confirms the
 * endpoint fails fast with a retriable 503 rather than hanging — the actual bug found while
 * reviewing this task. `BullmqSignalQueue`'s timeout budget is 3s, so this waits at least that
 * long by design; it does not use the real `startRedis()` container, and the delivery repository
 * is an in-memory fake since nothing about this test exercises idempotency.
 */
describe('POST /ingest/signals when the signal queue is unreachable (001 T019, FR-019)', () => {
  let app: NestExpressApplication;

  const noopDeliveries: IngestionDeliveryRepository = {
    findByDeliveryId: () => Promise.resolve(null),
    recordDelivery: () => Promise.reject(new Error('not implemented in this test')),
  };
  const noopIssues: IssueRepository = {
    create: () => Promise.reject(new Error('not implemented in this test')),
    findById: () => Promise.resolve(null),
    findOpenByFingerprint: () => Promise.resolve(null),
    findMostRecentlyResolvedByFingerprint: () => Promise.resolve(null),
    transition: () => Promise.reject(new Error('not implemented in this test')),
    recordOccurrence: () => Promise.reject(new Error('not implemented in this test')),
    findOpenCorrelationCandidates: () => Promise.reject(new Error('not implemented in this test')),
    correlate: () => Promise.reject(new Error('not implemented in this test')),
    list: () => Promise.resolve([]),
    findRelationships: () => Promise.reject(new Error('not implemented in this test')),
  };
  const noopEvidence: EvidenceRepository = {
    record: () => Promise.reject(new Error('not implemented in this test')),
    findById: () => Promise.resolve(null),
    detach: () => Promise.reject(new Error('not implemented in this test')),
    listByIssue: () => Promise.resolve([]),
  };
  const noopAudit: AuditRepository = {
    record: () => Promise.reject(new Error('not implemented in this test')),
    listByTarget: () => Promise.resolve([]),
    resolveAgentRunFacts: () => Promise.resolve(null),
  };

  beforeAll(async () => {
    const queue = new BullmqSignalQueue({ url: 'redis://127.0.0.1:6399' });
    const ApiModule = createApiModule(
      { service: 'healer-api', version: 'test', build: 'test', runnerProtocolVersion: 1 },
      queue,
      noopDeliveries,
      noopIssues,
      noopEvidence,
      noopAudit,
    );
    app = await NestFactory.create<NestExpressApplication>(ApiModule, { logger: false });
    configureApiPrefix(app);
    configureIngestBodyLimit(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('returns 503 within a bounded time instead of hanging', async () => {
    const startedAt = Date.now();
    await request(app.getHttpServer())
      .post('/api/v1/ingest/signals')
      .set('X-Tenant-Id', '00000000-0000-0000-8000-0000000000a9')
      .set('X-Delivery-Id', randomUUID())
      .set('X-Provider-Id', 'sentry')
      .send({
        signals: [
          {
            observedAt: '2026-01-01T00:00:00.000Z',
            component: 'checkout-api',
            environment: 'prod',
            errorSignature: { exceptionType: 'TimeoutError' },
          },
        ],
      })
      .expect(503);
    // Generous relative to the 3s budget, but nowhere near "hangs indefinitely" — the bug this
    // test exists to catch made the request never resolve at all.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 15_000);
});
