import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQueue } from '@healer/workflow';
import { BullmqSignalQueue } from '@healer/domain-issues';
import { assertTenantScopedEnqueue } from '../../test/tenant-isolation.js';
import { startRedis } from '../../test/containers.js';
import { configureIngestBodyLimit, createApiModule } from './src/main.js';

/**
 * Boots a real Redis (first consumer of `startRedis`, 012 T003) and a real Nest HTTP server to
 * prove `POST /ingest/signals` actually enqueues (001 T019, FR-019) — a unit test with a fake
 * `SignalQueue` cannot prove the BullMQ wiring itself works. Lives beside `src/`, not inside it:
 * `apps/api/tsconfig.json`'s `rootDir` is `src`, and its own project cannot reach outside that to
 * `test/containers.ts`; sitting outside `include` keeps it out of that project's file list, the
 * same way every other DB/Redis-backed e2e test at the repo root is outside any tsc project.
 */
describe('POST /ingest/signals (001 T019, FR-019)', () => {
  let redis: Awaited<ReturnType<typeof startRedis>>;
  let app: NestExpressApplication;

  const validSignal = () => ({
    observedAt: '2026-01-01T00:00:00.000Z',
    component: 'checkout-api',
    environment: 'prod',
    errorSignature: { exceptionType: 'TimeoutError' },
  });

  beforeAll(async () => {
    redis = await startRedis();
    const queue = new BullmqSignalQueue({ url: redis.url });
    const ApiModule = createApiModule(
      { service: 'healer-api', version: 'test', build: 'test', runnerProtocolVersion: 1 },
      queue,
    );
    app = await NestFactory.create<NestExpressApplication>(ApiModule, { logger: false });
    configureIngestBodyLimit(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await redis?.stop();
  });

  it('accepts a batch, returns 202 with the accepted count, and enqueues one job per signal', async () => {
    const tenantId = '00000000-0000-0000-8000-0000000000a1';
    const response = await request(app.getHttpServer())
      .post('/ingest/signals')
      .set('X-Tenant-Id', tenantId)
      .send({ signals: [validSignal(), validSignal()] })
      .expect(202);

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
      await assertTenantScopedEnqueue(app, 'POST', '/ingest/signals', {
        tenantA: '00000000-0000-0000-8000-0000000000a2',
        tenantB: '00000000-0000-0000-8000-0000000000a3',
        tenantHeader: 'X-Tenant-Id',
        expectStatus: 202,
        bodyFor: (marker) => ({ signals: [{ ...validSignal(), component: marker }] }),
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
    await request(app.getHttpServer())
      .post('/ingest/signals')
      .set('X-Tenant-Id', tenantId)
      .send({ signals: [validSignal(), validSignal(), validSignal()] })
      .expect(202);

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
    await request(app.getHttpServer())
      .post('/ingest/signals')
      .set('X-Tenant-Id', tenantId)
      .send({ signals: [{ ...validSignal(), observedAt: '2026-01-01T02:00:00+02:00' }] })
      .expect(202);
  });

  it('accepts a signal carrying an unrecognized field, dropping it rather than rejecting the batch', async () => {
    const tenantId = '00000000-0000-0000-8000-0000000000a8';
    await request(app.getHttpServer())
      .post('/ingest/signals')
      .set('X-Tenant-Id', tenantId)
      .send({
        signals: [{ ...validSignal(), newProviderField: 'unrecognized-but-forward-compatible' }],
      })
      .expect(202);
  });

  it('rejects a request with no X-Tenant-Id header', async () => {
    await request(app.getHttpServer())
      .post('/ingest/signals')
      .send({ signals: [validSignal()] })
      .expect(400);
  });

  it('rejects a batch over the 1000-item cap without enqueuing anything', async () => {
    const tenantId = '00000000-0000-0000-8000-0000000000a4';
    const signals = Array.from({ length: 1001 }, validSignal);
    await request(app.getHttpServer())
      .post('/ingest/signals')
      .set('X-Tenant-Id', tenantId)
      .send({ signals })
      .expect(400);

    const inspectQueue = createQueue('ingestion', { url: redis.url });
    try {
      const jobs = await inspectQueue.getJobs(['waiting', 'delayed', 'active']);
      expect(jobs.filter((job) => job.data.tenantId === tenantId)).toHaveLength(0);
    } finally {
      await inspectQueue.close();
    }
  });

  it('rejects a malformed signal (missing required errorSignature)', async () => {
    await request(app.getHttpServer())
      .post('/ingest/signals')
      .set('X-Tenant-Id', '00000000-0000-0000-8000-0000000000a5')
      .send({ signals: [{ observedAt: '2026-01-01T00:00:00.000Z', component: 'x' }] })
      .expect(400);
  });
});

/**
 * A separate app instance pointed at an unreachable Redis (001 T019 review): confirms the
 * endpoint fails fast with a retriable 503 rather than hanging — the actual bug found while
 * reviewing this task. `BullmqSignalQueue`'s timeout budget is 3s, so this waits at least that
 * long by design; it does not use the real `startRedis()` container.
 */
describe('POST /ingest/signals when the signal queue is unreachable (001 T019, FR-019)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const queue = new BullmqSignalQueue({ url: 'redis://127.0.0.1:6399' });
    const ApiModule = createApiModule(
      { service: 'healer-api', version: 'test', build: 'test', runnerProtocolVersion: 1 },
      queue,
    );
    app = await NestFactory.create<NestExpressApplication>(ApiModule, { logger: false });
    configureIngestBodyLimit(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('returns 503 within a bounded time instead of hanging', async () => {
    const startedAt = Date.now();
    await request(app.getHttpServer())
      .post('/ingest/signals')
      .set('X-Tenant-Id', '00000000-0000-0000-8000-0000000000a9')
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
