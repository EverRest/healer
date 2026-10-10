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
  PrismaAgentRunRepository,
  PrismaApprovalLifecycleRepository,
  PrismaAutonomyGrantRepository,
  PrismaBudgetLimitRepository,
  PrismaBudgetRepository,
  PrismaPolicyActionRepository,
  PrismaPolicyDecisionRepository,
  PrismaPolicyRulesetRepository,
} from '@healer/domain-policy';
import {
  PrismaDiscoveryRepository,
  PrismaDraftReviewRepository,
  PrismaGraphReadRepository,
} from '@healer/domain-architecture';
import { PrismaBoundaryRejectionRepository } from '@healer/domain-context';
import { PrismaClient } from '@healer/prisma-client';
import { applySqlFile, query, startPostgres, type StartedPostgres } from '../../test/containers.js';
import { seedBase, seededPromptVersionId } from '../../test/budget-fixtures.js';
import { PrismaRunnerRegistrationRepository } from './src/runners/infrastructure/prisma-runner-registration-repository.js';
import { configureApiPrefix, createApiModule } from './src/main.js';

/**
 * `POST /runners/agent-run-reports` end to end (012 T094, FR-033, FR-046a): the real Nest DI
 * graph and a real Postgres. Tenancy is the boundary under test — the tenant comes from auth
 * context only, and a runner name is merely the lookup key into *that tenant's* registrations.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));
const migrationNames = () =>
  readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

const TENANT_A = '00000000-0000-0000-8000-0000000000a1';
const TENANT_B = '00000000-0000-0000-8000-0000000000b1';

describe('POST /runners/agent-run-reports (012 T094)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let app: NestExpressApplication;

  const body = (overrides: Record<string, unknown> = {}, report: Record<string, unknown> = {}) => ({
    reportId: randomUUID(),
    correlationId: randomUUID(),
    startedAt: '2026-10-08T10:00:00.000Z',
    report: {
      kind: 'agent_run_report',
      agentKind: 'change',
      modelId: 'claude-sonnet-5',
      provider: 'anthropic',
      promptVersionId: seededPromptVersionId(),
      inputTokens: 100,
      outputTokens: 50,
      cost: 0.0123,
      toolCalls: [{ name: 'read_file', argumentDigest: 'a'.repeat(64), outcome: 'ok' }],
      decisionPathStepIds: ['step-1'],
      outcome: 'completed',
      durationMs: 500,
      ...report,
    },
    ...overrides,
  });

  const post = (tenantId: string | undefined, runner: string | undefined, payload: unknown) => {
    const req = request(app.getHttpServer()).post('/api/v1/runners/agent-run-reports');
    if (tenantId !== undefined) req.set('X-Tenant-Id', tenantId);
    if (runner !== undefined) req.set('X-Runner-Name', runner);
    return req.send(payload as object);
  };

  const runs = (tenantId: string) => prisma.agentRun.findMany({ where: { tenantId } });

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    await seedBase(pg);
    await query(
      pg,
      `insert into "tenant"."tenant" (id, name) values ('${TENANT_A}', 'tenant-a'), ('${TENANT_B}', 'tenant-b')`,
    );
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    await prisma.runnerRegistration.create({
      data: {
        id: randomUUID(),
        tenantId: TENANT_A,
        name: 'runner-a',
        protocolVersion: 1,
        capabilities: [],
        imageVersion: '1.0.0',
        status: 'active',
        lastHeartbeatAt: new Date(),
      },
    });
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
      new PrismaDiscoveryRepository(prisma),
      new PrismaDraftReviewRepository(prisma),
      new PrismaBoundaryRejectionRepository(prisma),
      new PrismaAgentRunRepository(prisma),
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

  it('records the report as a runner-side agent_run with reported provenance; a redelivery is a 200 no-op', async () => {
    const payload = body();
    const first = await post(TENANT_A, 'runner-a', payload).expect(201);
    const again = await post(TENANT_A, 'runner-a', payload).expect(200);

    expect(again.body).toEqual({ id: first.body.id, created: false });
    const rows = await runs(TENANT_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: first.body.id,
      executedIn: 'runner',
      costProvenance: 'reported',
      reportId: payload.reportId,
    });
    expect(rows[0]?.runnerInstanceId).not.toBeNull();
    expect(rows[0]?.cost.toFixed(6)).toBe('0.012300');
  });

  it("another tenant's runner name is a 404 and writes nothing for either tenant", async () => {
    await post(TENANT_B, 'runner-a', body()).expect(404);
    expect(await runs(TENANT_B)).toHaveLength(0);
    expect(await runs(TENANT_A)).toHaveLength(1); // only the previous test's row
  });

  it('refuses a body that is not the closed shape — before anything is written', async () => {
    const before = (await runs(TENANT_A)).length;
    await post(TENANT_A, 'runner-a', body({}, { cost: -1 })).expect(400);
    await post(TENANT_A, 'runner-a', body({}, { provider: 'acme' })).expect(400);
    await post(TENANT_A, 'runner-a', body({ tenantId: TENANT_B })).expect(400);
    await post(TENANT_A, undefined, body()).expect(400); // no runner name
    await post(undefined, 'runner-a', body()).expect(400); // no tenant
    expect(await runs(TENANT_A)).toHaveLength(before);
  });

  it('maps an unknown prompt version to 422 and a reused reportId with other content to 409', async () => {
    await post(TENANT_A, 'runner-a', body({}, { promptVersionId: randomUUID() })).expect(422);
    const payload = body();
    await post(TENANT_A, 'runner-a', payload).expect(201);
    await post(TENANT_A, 'runner-a', { ...payload, report: { ...payload.report, cost: 9 } }).expect(
      409,
    );
  });
});
