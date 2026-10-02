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
import { PrismaClient } from '@healer/prisma-client';
import {
  assertTenantIsolated,
  assertTenantIsolatedList,
  assertTenantScopedEnqueue,
} from '../../test/tenant-isolation.js';
import { applySqlFile, query, startPostgres, type StartedPostgres } from '../../test/containers.js';
import { configureApiPrefix, createApiModule } from './src/main.js';
import { PrismaRunnerRegistrationRepository } from './src/runners/infrastructure/prisma-runner-registration-repository.js';

/**
 * `GET /autonomy/grants`, `POST /autonomy/grants`, `DELETE /autonomy/grants/{grantId}` (T046,
 * FR-007) over real HTTP against real Postgres, plus the tenant-isolation matrix
 * `.claude/rules/backend-nestjs.md` requires for every endpoint that takes or returns an id.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

describe('/autonomy/grants (002 T046)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let app: NestExpressApplication;

  const path = (p: string) => `/api/v1${p}`;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    await query(
      pg,
      `insert into "policy"."policy_action" (action_key, action_class, mutating, owning_spec, introduced_at)
       values ('change.open_pull_request', 'code_change', true, '008', now()),
              ('deployment.rollback', 'reversible_remediation', true, '010', now())`,
    );

    prisma = new PrismaClient({ datasourceUrl: pg.url });
    const rulesets = new PrismaPolicyRulesetRepository(prisma);
    const decisions = new PrismaPolicyDecisionRepository(prisma);
    const actions = new PrismaPolicyActionRepository(prisma);
    const autonomyGrants = new PrismaAutonomyGrantRepository(prisma);

    const ApiModule = createApiModule(
      { service: 'healer-api', version: 'test', build: 'test', runnerProtocolVersion: 1 },
      new BullmqSignalQueue({ url: 'redis://127.0.0.1:6399' }),
      new PrismaIngestionDeliveryRepository(prisma),
      new PrismaIssueRepository(prisma),
      new PrismaEvidenceRepository(prisma),
      new PrismaAuditRepository(prisma),
      new PrismaTimelineRepository(prisma),
      new PrismaEvidenceGraphRepository(prisma),
      rulesets,
      decisions,
      actions,
      new PrismaRunnerRegistrationRepository(prisma),
      autonomyGrants,
      new PrismaBudgetRepository(prisma),
      new PrismaBudgetLimitRepository(prisma),
      new PrismaApprovalLifecycleRepository(prisma),
      new PrismaGraphReadRepository(prisma),
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

  function grantBody(overrides: Record<string, unknown> = {}) {
    return { actionKey: 'change.open_pull_request', level: 1, ...overrides };
  }

  it('grants an autonomy level at or under the ceiling', async () => {
    const response = await request(app.getHttpServer())
      .post(path('/autonomy/grants'))
      .set('X-Tenant-Id', randomUUID())
      .set('X-Actor-Id', 'pavlo')
      .set('Idempotency-Key', randomUUID())
      .send(grantBody({ level: 2 }))
      .expect(201);
    expect(response.body).toMatchObject({ actionKey: 'change.open_pull_request', level: 2 });
  });

  // Quickstart 7: grant L3 for change.open_pull_request (ceiling L2) → 422 CEILING_EXCEEDED.
  it('refuses a level above the ceiling with 422', async () => {
    await request(app.getHttpServer())
      .post(path('/autonomy/grants'))
      .set('X-Tenant-Id', randomUUID())
      .set('X-Actor-Id', 'pavlo')
      .set('Idempotency-Key', randomUUID())
      .send(grantBody({ level: 3 }))
      .expect(422);
  });

  it('revokes a grant', async () => {
    const tenantId = randomUUID();
    const created = await request(app.getHttpServer())
      .post(path('/autonomy/grants'))
      .set('X-Tenant-Id', tenantId)
      .set('X-Actor-Id', 'pavlo')
      .set('Idempotency-Key', randomUUID())
      .send(grantBody())
      .expect(201);

    const revoked = await request(app.getHttpServer())
      .delete(path(`/autonomy/grants/${created.body.id}`))
      .set('X-Tenant-Id', tenantId)
      .set('X-Actor-Id', 'pavlo')
      .expect(200);
    expect(revoked.body.revokedAt).not.toBeNull();

    // data-model.md: terminal, never reactivated — a second revoke is a conflict, not a no-op.
    await request(app.getHttpServer())
      .delete(path(`/autonomy/grants/${created.body.id}`))
      .set('X-Tenant-Id', tenantId)
      .set('X-Actor-Id', 'pavlo')
      .expect(409);
  });

  it('404s revoking a grant that does not exist', async () => {
    await request(app.getHttpServer())
      .delete(path(`/autonomy/grants/${randomUUID()}`))
      .set('X-Tenant-Id', randomUUID())
      .set('X-Actor-Id', 'pavlo')
      .expect(404);
  });

  describe('tenant isolation (FR-018)', () => {
    it('POST /autonomy/grants: a grant created under tenant A never lands under tenant B', async () =>
      assertTenantScopedEnqueue(app, 'POST', '/api/v1/autonomy/grants', {
        tenantA: randomUUID(),
        tenantB: randomUUID(),
        tenantHeader: 'X-Tenant-Id',
        expectStatus: 201,
        // `environment` is the one free-text field this request carries a marker in.
        bodyFor: (marker) => grantBody({ environment: marker }),
        headersFor: () => ({ 'X-Actor-Id': 'pavlo', 'Idempotency-Key': randomUUID() }),
        tenantIdFor: async (marker) => {
          const grant = await prisma.autonomyGrant.findFirst({ where: { environment: marker } });
          return grant?.tenantId;
        },
      }));

    it("GET /autonomy/grants: a list never contains another tenant's grants", async () => {
      const tenantId = randomUUID();
      const created = await request(app.getHttpServer())
        .post(path('/autonomy/grants'))
        .set('X-Tenant-Id', tenantId)
        .set('X-Actor-Id', 'pavlo')
        .set('Idempotency-Key', randomUUID())
        .send(grantBody())
        .expect(201);

      await assertTenantIsolatedList(app, 'GET', '/api/v1/autonomy/grants', {
        tenantA: tenantId,
        tenantB: randomUUID(),
        tenantHeader: 'X-Tenant-Id',
        createUnderA: async () => created.body.id,
        responseContainsMarker: (body, marker) =>
          (body as { items: { id: string }[] }).items.some((item) => item.id === marker),
      });
    });

    it("DELETE /autonomy/grants/{grantId}: another tenant's grant id returns 404, never 403", async () =>
      assertTenantIsolated(app, 'DELETE', '/api/v1/autonomy/grants/:grantId', {
        tenantA: randomUUID(),
        tenantB: randomUUID(),
        tenantHeader: 'X-Tenant-Id',
        requestHeaders: { 'X-Actor-Id': 'pavlo' },
        createUnderTenant: async (tenantId) => {
          const created = await request(app.getHttpServer())
            .post(path('/autonomy/grants'))
            .set('X-Tenant-Id', tenantId)
            .set('X-Actor-Id', 'pavlo')
            .set('Idempotency-Key', randomUUID())
            .send(grantBody())
            .expect(201);
          return created.body.id as string;
        },
      }));
  });
});
