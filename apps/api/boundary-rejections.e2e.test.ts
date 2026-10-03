import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BullmqSignalQueue,
  PrismaAuditRepository,
  PrismaIngestionDeliveryRepository,
  PrismaIssueRepository,
  PrismaTimelineRepository,
} from '@healer/domain-issues';
import { PrismaEvidenceGraphRepository, PrismaEvidenceRepository } from '@healer/domain-evidence';
import {
  PrismaApprovalLifecycleRepository,
  PrismaAutonomyGrantRepository,
  PrismaBudgetLimitRepository,
  PrismaBudgetRepository,
  PrismaPolicyActionRepository,
  PrismaPolicyDecisionRepository,
  PrismaPolicyRulesetRepository,
} from '@healer/domain-policy';
import { PrismaGraphReadRepository } from '@healer/domain-architecture';
import { acceptResultBatch, PrismaBoundaryRejectionRepository } from '@healer/domain-context';
import { PrismaClient } from '@healer/prisma-client';
import { newCorrelationId, TenantContext, withCorrelation } from '@healer/shared';
import { assertTenantIsolatedList } from '../../test/tenant-isolation.js';
import { applySqlFile, startPostgres, type StartedPostgres } from '../../test/containers.js';
import { configureApiPrefix, createApiModule } from './src/main.js';
import { PrismaRunnerRegistrationRepository } from './src/runners/infrastructure/prisma-runner-registration-repository.js';

/**
 * `GET /boundary-rejections` (003 T030, FR-010, quickstart 35) over real HTTP against real
 * Postgres, plus the tenant-isolation check every list endpoint needs: a tenant sees its own
 * rejections and counts, never another tenant's.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));
const RUNNER_1 = '0190b7a0-0000-7000-8000-0000000000a1';
const RUNNER_2 = '0190b7a0-0000-7000-8000-0000000000a2';

describe('/boundary-rejections (003 T030)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let app: NestExpressApplication;
  let rejections: PrismaBoundaryRejectionRepository;

  const path = '/api/v1/boundary-rejections';

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    rejections = new PrismaBoundaryRejectionRepository(prisma);
    const ApiModule = createApiModule(
      { service: 'healer-api', version: 'test', build: 'test', runnerProtocolVersion: 1 },
      new BullmqSignalQueue({ url: 'redis://127.0.0.1:6399' }),
      new PrismaIngestionDeliveryRepository(prisma),
      new PrismaIssueRepository(prisma),
      new PrismaEvidenceRepository(prisma),
      new PrismaAuditRepository(prisma),
      new PrismaTimelineRepository(prisma),
      new PrismaEvidenceGraphRepository(prisma),
      new PrismaPolicyRulesetRepository(prisma),
      new PrismaPolicyDecisionRepository(prisma),
      new PrismaPolicyActionRepository(prisma),
      new PrismaRunnerRegistrationRepository(prisma),
      new PrismaAutonomyGrantRepository(prisma),
      new PrismaBudgetRepository(prisma),
      new PrismaBudgetLimitRepository(prisma),
      new PrismaApprovalLifecycleRepository(prisma),
      new PrismaGraphReadRepository(prisma),
      rejections,
    );
    app = await NestFactory.create<NestExpressApplication>(ApiModule, { logger: false });
    configureApiPrefix(app);
    await app.init();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await pg?.stop();
  });

  /** A real ingress rejection, as the runner-facing endpoint will produce it. */
  async function reject(tenantId: string, runnerId: string): Promise<string> {
    const error = await withCorrelation(newCorrelationId(), () =>
      acceptResultBatch({ rejections }, TenantContext.forTrustedInternalUse(tenantId), {
        runnerId,
        rawBody: '{"not":"a batch"}',
      }),
    ).catch((e: unknown) => e as { rejectionId: string });
    return (error as { rejectionId: string }).rejectionId;
  }

  it("lists this tenant's rejections with totals and per-runner counts, payload-free", async () => {
    const tenantId = randomUUID();
    const first = await reject(tenantId, RUNNER_1);
    await reject(tenantId, RUNNER_1);
    await reject(tenantId, RUNNER_2);

    const response = await request(app.getHttpServer())
      .get(path)
      .set('X-Tenant-Id', tenantId)
      .expect(200);
    expect(response.body.total).toBe(3);
    expect(response.body.countsByRunner).toEqual({ [RUNNER_1]: 2, [RUNNER_2]: 1 });
    expect(response.body.items).toHaveLength(3);
    const item = response.body.items.find((i: { id: string }) => i.id === first);
    expect(item).toMatchObject({
      runnerId: RUNNER_1,
      passId: null,
      contractVersion: 1,
      byteSize: Buffer.byteLength('{"not":"a batch"}'),
    });
    expect(item.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(item.schemaErrorPaths.length).toBeGreaterThan(0);
    expect(Object.keys(item).sort()).toEqual([
      'byteSize',
      'contractVersion',
      'id',
      'passId',
      'payloadDigest',
      'receivedAt',
      'runnerId',
      'schemaErrorPaths',
    ]);
  });

  it('filters by runnerId and since', async () => {
    const tenantId = randomUUID();
    await reject(tenantId, RUNNER_1);
    await reject(tenantId, RUNNER_2);

    const byRunner = await request(app.getHttpServer())
      .get(`${path}?runnerId=${RUNNER_2}`)
      .set('X-Tenant-Id', tenantId)
      .expect(200);
    expect(byRunner.body.total).toBe(1);

    const future = encodeURIComponent(new Date(Date.now() + 60_000).toISOString());
    const bySince = await request(app.getHttpServer())
      .get(`${path}?since=${future}`)
      .set('X-Tenant-Id', tenantId)
      .expect(200);
    expect(bySince.body).toEqual({ items: [], total: 0, countsByRunner: {} });
  });

  it('rejects a malformed filter with 422 and a missing tenant with 400', async () => {
    await request(app.getHttpServer())
      .get(`${path}?runnerId=nope`)
      .set('X-Tenant-Id', randomUUID())
      .expect(422);
    // an offset the datetime check accepts but `Date` cannot parse must not reach the database
    for (const since of ['2024-01-01T00:00:00+99:99', '2024-01-01T00:00:00+24:00']) {
      await request(app.getHttpServer())
        .get(`${path}?since=${encodeURIComponent(since)}`)
        .set('X-Tenant-Id', randomUUID())
        .expect(422);
    }
    await request(app.getHttpServer()).get(path).expect(400);
  });

  it("never shows one tenant's rejections to another (list isolation)", async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    await assertTenantIsolatedList(app, 'GET', '/api/v1/boundary-rejections', {
      tenantA,
      tenantB,
      tenantHeader: 'X-Tenant-Id',
      createUnderA: () => reject(tenantA, RUNNER_1),
      responseContainsMarker: (body, marker) =>
        (body as { items: { id: string }[] }).items.some((i) => i.id === marker),
    });
    const b = await request(app.getHttpServer()).get(path).set('X-Tenant-Id', tenantB).expect(200);
    expect(b.body).toEqual({ items: [], total: 0, countsByRunner: {} });
  });
});
