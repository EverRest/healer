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
  PrismaBudgetLimitRepository,
  PrismaBudgetRepository,
  PrismaAutonomyGrantRepository,
  PrismaPolicyActionRepository,
  PrismaPolicyDecisionRepository,
  PrismaPolicyRulesetRepository,
  SEED_POLICY_ACTIONS,
  revokeAutonomy,
} from '@healer/domain-policy';
import { PrismaClient } from '@healer/prisma-client';
import { TenantContext, newCorrelationId, withCorrelation } from '@healer/shared';
import { applySqlFile, startPostgres, type StartedPostgres } from '../../test/containers.js';
import { seedPendingApproval } from '../../test/approval-fixture.js';
import { configureApiPrefix, createApiModule } from './src/main.js';
import { PrismaRunnerRegistrationRepository } from './src/runners/infrastructure/prisma-runner-registration-repository.js';

/**
 * `GET /approvals`, `GET /approvals/{approvalId}`, `POST /approvals/{approvalId}/resolve`
 * (002 T075, FR-015, FR-017) over real HTTP against real Postgres. The tenant-isolation matrix
 * for these three lives in `policy.e2e.test.ts`, which is T032's home.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));
const migrationNames = () =>
  readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

describe('/approvals (002 T075)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let app: NestExpressApplication;
  let grants: PrismaAutonomyGrantRepository;

  const path = (p: string) => `/api/v1${p}`;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    for (const action of SEED_POLICY_ACTIONS) {
      await prisma.policyAction.create({
        data: { ...action, introducedAt: new Date('2026-01-01T00:00:00Z') },
      });
    }
    grants = new PrismaAutonomyGrantRepository(prisma);

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
      grants,
      new PrismaBudgetRepository(prisma),
      new PrismaBudgetLimitRepository(prisma),
      new PrismaApprovalLifecycleRepository(prisma),
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

  const resolveAs = (tenantId: string, approvalId: string, body: unknown, actor = 'alice') =>
    request(app.getHttpServer())
      .post(path(`/approvals/${approvalId}/resolve`))
      .set('X-Tenant-Id', tenantId)
      .set('X-Actor-Id', actor)
      .set('Idempotency-Key', randomUUID())
      .send(body as object);

  it('shows what the approver decides on: action, reasons, impact, rollback, evidence ids', async () => {
    const tenantId = randomUUID();
    const { approval } = await seedPendingApproval(prisma, tenantId);
    const response = await request(app.getHttpServer())
      .get(path(`/approvals/${approval.id}`))
      .set('X-Tenant-Id', tenantId)
      .expect(200);
    expect(response.body).toMatchObject({
      id: approval.id,
      state: 'pending',
      evidenceIds: [expect.any(String)],
      summary: {
        proposedAction: 'change.open_pull_request',
        reasonCodes: ['APPROVAL_REQUIRED'],
        impactSummary: { touchesAuthPath: false },
        rollbackPlan: { reversible: true, hasTestedUndo: true },
      },
    });
  });

  it('lists approvals, filtered by state', async () => {
    const tenantId = randomUUID();
    const { approval } = await seedPendingApproval(prisma, tenantId);
    const pending = await request(app.getHttpServer())
      .get(path('/approvals?state=pending'))
      .set('X-Tenant-Id', tenantId)
      .expect(200);
    expect(pending.body.items.map((a: { id: string }) => a.id)).toEqual([approval.id]);
    const approved = await request(app.getHttpServer())
      .get(path('/approvals?state=approved'))
      .set('X-Tenant-Id', tenantId)
      .expect(200);
    expect(approved.body.items).toEqual([]);
    await request(app.getHttpServer())
      .get(path('/approvals?state=bogus'))
      .set('X-Tenant-Id', tenantId)
      .expect(422);
  });

  it('resolves with the human from the auth context, never the body; a second resolve is 409', async () => {
    const tenantId = randomUUID();
    const { approval } = await seedPendingApproval(prisma, tenantId);
    const resolved = await resolveAs(tenantId, approval.id, {
      resolution: 'approved',
      note: 'checked the diff',
    }).expect(200);
    expect(resolved.body).toMatchObject({ state: 'approved', resolvedBy: 'alice' });

    await resolveAs(tenantId, approval.id, { resolution: 'rejected' }, 'bob').expect(409);
    // A body that names an approver is refused outright, not ignored.
    await resolveAs(tenantId, approval.id, {
      resolution: 'approved',
      resolvedBy: 'mallory',
    }).expect(422);
  });

  it('refuses a malformed body (422) and a missing idempotency key (400)', async () => {
    const tenantId = randomUUID();
    const { approval } = await seedPendingApproval(prisma, tenantId);
    await resolveAs(tenantId, approval.id, { resolution: 'maybe' }).expect(422);
    await request(app.getHttpServer())
      .post(path(`/approvals/${approval.id}/resolve`))
      .set('X-Tenant-Id', tenantId)
      .set('X-Actor-Id', 'alice')
      .send({ resolution: 'approved' })
      .expect(400);
  });

  it('SC-007: a request past its expiry is 409 even before the tick fires, and stays pending', async () => {
    const tenantId = randomUUID();
    const { approval } = await seedPendingApproval(prisma, tenantId, {
      expiresAt: new Date(Date.now() - 60_000),
    });
    await resolveAs(tenantId, approval.id, { resolution: 'approved' }).expect(409);
    expect(
      (await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } })).state,
    ).toBe('pending');
  });

  it('R-07: revoked after the request was issued, sweep never run -> 409, nothing resolved', async () => {
    const tenantId = randomUUID();
    const { approval, grantId } = await seedPendingApproval(prisma, tenantId);
    await withCorrelation(newCorrelationId(), () =>
      revokeAutonomy({ grants }, TenantContext.forTrustedInternalUse(tenantId), {
        grantId,
        revokedBy: 'pavlo',
      }),
    );
    const response = await resolveAs(tenantId, approval.id, { resolution: 'approved' }).expect(409);
    expect(response.body.message).toMatch(/autonomy epoch/);
    expect(
      await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } }),
    ).toMatchObject({ state: 'pending', resolvedBy: null });
  });

  it('404s an unknown or malformed approval id', async () => {
    const tenantId = randomUUID();
    await request(app.getHttpServer())
      .get(path(`/approvals/${randomUUID()}`))
      .set('X-Tenant-Id', tenantId)
      .expect(404);
    await request(app.getHttpServer())
      .get(path('/approvals/not-a-uuid'))
      .set('X-Tenant-Id', tenantId)
      .expect(404);
    await resolveAs(tenantId, randomUUID(), { resolution: 'approved' }).expect(404);
  });
});
