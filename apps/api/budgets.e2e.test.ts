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
  BUDGET_BOUNDS,
  PrismaAutonomyGrantRepository,
  PrismaBudgetLimitRepository,
  PrismaBudgetRepository,
  PrismaPolicyActionRepository,
  PrismaPolicyDecisionRepository,
  PrismaPolicyRulesetRepository,
} from '@healer/domain-policy';
import { PrismaClient } from '@healer/prisma-client';
import {
  assertTenantIsolated,
  assertTenantIsolatedList,
  assertTenantScopedEnqueue,
} from '../../test/tenant-isolation.js';
import { applySqlFile, startPostgres, type StartedPostgres } from '../../test/containers.js';
import { seedAgentRun, seedBase, seedIssue } from '../../test/budget-fixtures.js';
import { configureApiPrefix, createApiModule } from './src/main.js';
import { PrismaRunnerRegistrationRepository } from './src/runners/infrastructure/prisma-runner-registration-repository.js';

/**
 * `GET /budgets`, `PUT /budgets`, `GET /budgets/state` (002 T067, FR-011, FR-020) over real HTTP
 * against real Postgres, with the tenant-isolation matrix every endpoint needs
 * (`.claude/rules/backend-nestjs.md`).
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));
const migrationNames = () =>
  readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

describe('/budgets (002 T067)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let app: NestExpressApplication;

  const path = (p: string) => `/api/v1${p}`;
  const put = (tenantId: string, body: unknown, actor = 'pavlo') =>
    request(app.getHttpServer())
      .put(path('/budgets'))
      .set('X-Tenant-Id', tenantId)
      .set('X-Actor-Id', actor)
      .set('Idempotency-Key', randomUUID())
      .send(body as object);

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    await seedBase(pg);
    prisma = new PrismaClient({ datasourceUrl: pg.url });
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

  describe('PUT /budgets', () => {
    it('writes a limit, and GET /budgets reads it back', async () => {
      const tenantId = randomUUID();
      await put(tenantId, {
        scopeType: 'tenant',
        period: 'day',
        spendLimit: 12.5,
        timeLimitMs: 3_600_000,
        softThresholdPcts: [75, 50],
        escalationAttemptCap: 3,
      }).expect(200);

      const listed = await request(app.getHttpServer())
        .get(path('/budgets'))
        .set('X-Tenant-Id', tenantId)
        .expect(200);
      expect(listed.body.items).toEqual([
        {
          scopeType: 'tenant',
          period: 'day',
          spendLimit: 12.5,
          timeLimitMs: 3_600_000,
          softThresholdPcts: [50, 75],
          escalationAttemptCap: 3,
          updatedBy: 'pavlo',
        },
      ]);
    });

    it('a partial write keeps what is configured and fills the rest with the fail-closed default', async () => {
      const tenantId = randomUUID();
      await put(tenantId, { scopeType: 'tenant', period: 'month', spendLimit: 30 }).expect(200);
      await put(tenantId, { scopeType: 'tenant', period: 'month', escalationAttemptCap: 1 }).expect(
        200,
      );
      const listed = await request(app.getHttpServer())
        .get(path('/budgets'))
        .set('X-Tenant-Id', tenantId);
      expect(listed.body.items[0]).toMatchObject({
        period: 'month',
        spendLimit: 30,
        escalationAttemptCap: 1,
        softThresholdPcts: [50, 75, 90],
      });
    });

    // Quickstart 41 / T088: stop rules have bounds, refused at the configuration write.
    it('refuses an escalation attempt cap above the product bound with 422', async () => {
      const res = await put(randomUUID(), {
        scopeType: 'tenant',
        period: 'day',
        escalationAttemptCap: BUDGET_BOUNDS.maxEscalationAttemptCap + 1,
      }).expect(422);
      expect(JSON.stringify(res.body)).toMatch(/escalationAttemptCap/);
    });

    it.each([
      ['tenant', 'day'],
      ['tenant', 'month'],
      ['issue', 'issue'],
    ] as const)(
      'refuses a %s/%s spend limit above the product bound with 422',
      async (scopeType, period) => {
        await put(randomUUID(), {
          scopeType,
          period,
          spendLimit: BUDGET_BOUNDS.maxSpendLimit[period] + 1,
        }).expect(422);
      },
    );

    it('refuses a scope/period pairing the product has no budget for', async () => {
      await put(randomUUID(), { scopeType: 'issue', period: 'day' }).expect(422);
    });

    it('refuses a body with a field the contract does not have', async () => {
      await put(randomUUID(), { scopeType: 'tenant', period: 'day', unlimited: true }).expect(422);
    });

    it('needs an actor and an idempotency key', async () => {
      await request(app.getHttpServer())
        .put(path('/budgets'))
        .set('X-Tenant-Id', randomUUID())
        .send({ scopeType: 'tenant', period: 'day' })
        .expect(400);
    });

    // Quickstart 37: a change to budget configuration is audited, naming actor, before and after.
    it('audits the change, naming the actor and the before and after figures', async () => {
      const tenantId = randomUUID();
      await put(tenantId, { scopeType: 'tenant', period: 'day', spendLimit: 5 }, 'alice').expect(
        200,
      );
      await put(tenantId, { scopeType: 'tenant', period: 'day', spendLimit: 8 }, 'bob').expect(200);
      const entries = await prisma.auditEntry.findMany({
        where: { tenantId, action: 'policy.update_budget' },
        orderBy: { occurredAt: 'asc' },
      });
      expect(entries.map((e) => e.actorRef)).toEqual(['alice', 'bob']);
      expect(entries[0]?.reason).toContain('spendLimit unset -> 5');
      expect(entries[1]?.reason).toContain('spendLimit 5 -> 8');
    });
  });

  describe('GET /budgets/state', () => {
    it('reports the derived consumption, the degradation step and the entries applied so far', async () => {
      const tenantId = randomUUID();
      await put(tenantId, { scopeType: 'tenant', period: 'day', spendLimit: 10 }).expect(200);
      await seedAgentRun(pg, { tenantId, cost: 8, startedAt: new Date().toISOString() });

      const res = await request(app.getHttpServer())
        .get(path('/budgets/state'))
        .query({ scopeType: 'tenant' })
        .set('X-Tenant-Id', tenantId)
        .expect(200);
      expect(res.body).toMatchObject({
        consumedSpend: 8,
        spendLimit: 10,
        degradationStep: 2,
        degradationApplied: ['cheaper_tier', 'reduced_context'],
        state: 'degraded',
      });
    });

    it('an issue past its budget reads as exhausted', async () => {
      const tenantId = randomUUID();
      await put(tenantId, { scopeType: 'issue', period: 'issue', spendLimit: 1 }).expect(200);
      const issueId = await seedIssue(pg, tenantId);
      await seedAgentRun(pg, { tenantId, issueId, cost: 1 });
      const res = await request(app.getHttpServer())
        .get(path('/budgets/state'))
        .query({ scopeType: 'issue', scopeId: issueId })
        .set('X-Tenant-Id', tenantId)
        .expect(200);
      expect(res.body).toMatchObject({ state: 'exhausted', periodKey: 'issue' });
    });

    it('needs scopeType, and a scopeId for an issue', async () => {
      const tenantId = randomUUID();
      await request(app.getHttpServer())
        .get(path('/budgets/state'))
        .set('X-Tenant-Id', tenantId)
        .expect(422);
      await request(app.getHttpServer())
        .get(path('/budgets/state'))
        .query({ scopeType: 'issue' })
        .set('X-Tenant-Id', tenantId)
        .expect(422);
    });
  });

  describe('tenant isolation (FR-018, SC-008)', () => {
    it("GET /budgets: a list never contains another tenant's limits", async () => {
      const tenantA = randomUUID();
      const marker = (1 + Math.random() * 40).toFixed(4);
      await assertTenantIsolatedList(app, 'GET', '/api/v1/budgets', {
        tenantA,
        tenantB: randomUUID(),
        tenantHeader: 'X-Tenant-Id',
        createUnderA: async () => {
          await put(tenantA, {
            scopeType: 'tenant',
            period: 'day',
            spendLimit: Number(marker),
          }).expect(200);
          return marker;
        },
        responseContainsMarker: (body, m) =>
          (body as { items: { spendLimit: number }[] }).items.some(
            (item) => item.spendLimit === Number(m),
          ),
      });
    });

    it('PUT /budgets: a limit written under tenant A never lands under tenant B', async () =>
      assertTenantScopedEnqueue(app, 'PUT', '/api/v1/budgets', {
        tenantA: randomUUID(),
        tenantB: randomUUID(),
        tenantHeader: 'X-Tenant-Id',
        expectStatus: 200,
        bodyFor: () => ({ scopeType: 'tenant', period: 'day', spendLimit: 5 }),
        // `X-Actor-Id` is the one free-text value this request carries a marker in.
        headersFor: (marker) => ({ 'X-Actor-Id': marker, 'Idempotency-Key': randomUUID() }),
        tenantIdFor: async (marker) => {
          const row = await prisma.budgetLimit.findFirst({ where: { updatedBy: marker } });
          return row?.tenantId;
        },
      }));

    it("GET /budgets/state: another tenant's issue returns 404, never 403", async () =>
      assertTenantIsolated(app, 'GET', '/api/v1/budgets/state', {
        tenantA: randomUUID(),
        tenantB: randomUUID(),
        tenantHeader: 'X-Tenant-Id',
        createUnderTenant: (tenantId) => seedIssue(pg, tenantId),
        queryFor: (issueId) => ({ scopeType: 'issue', scopeId: issueId }),
      }));
  });
});
