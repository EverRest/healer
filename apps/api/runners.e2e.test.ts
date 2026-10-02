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
  PrismaPolicyActionRepository,
  PrismaPolicyDecisionRepository,
  PrismaPolicyRulesetRepository,
} from '@healer/domain-policy';
import { findStaleRunners, CURRENT_PROTOCOL_VERSION } from '@healer/boundary-contract';
import { TenantContext, scope } from '@healer/shared';
import { PrismaClient } from '@healer/prisma-client';
import { assertTenantScopedEnqueue } from '../../test/tenant-isolation.js';
import { applySqlFile, query, startPostgres, type StartedPostgres } from '../../test/containers.js';
import { PrismaRunnerRegistrationRepository } from './src/runners/infrastructure/prisma-runner-registration-repository.js';
import { configureApiPrefix, createApiModule } from './src/main.js';

/**
 * `POST /runners/heartbeat` end to end (012 T042, FR-018, FR-020): registration and every later
 * heartbeat are the same call — the real Nest DI graph, a real Postgres, no fakes — proving the
 * handshake result actually lands in `runner_registration` and that a repeat heartbeat updates
 * the same row rather than creating a second one.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_A = '00000000-0000-0000-8000-0000000000a1';
const TENANT_B = '00000000-0000-0000-8000-0000000000b1';

function validHeartbeatBody(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    imageVersion: '1.0.0',
    capabilities: ['read_logs'],
    resourceLimits: { cpu: 2, memoryMb: 2048, maxConcurrentRuns: 4 },
    ...overrides,
  };
}

describe('POST /runners/heartbeat (012 T042, FR-018, FR-020)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let app: NestExpressApplication;
  let runnerRegistrations: PrismaRunnerRegistrationRepository;

  const post = (tenantId: string, body: unknown) =>
    request(app.getHttpServer())
      .post('/api/v1/runners/heartbeat')
      .set('X-Tenant-Id', tenantId)
      .send(body);

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    // `runner_registration.tenant_id` carries a real foreign key to `tenant` (schema.prisma) —
    // unlike `issue`, which has none yet. Both fixture tenants must exist first.
    await query(
      pg,
      `insert into "tenant"."tenant" (id, name) values ('${TENANT_A}', 'tenant-a'), ('${TENANT_B}', 'tenant-b')`,
    );
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    runnerRegistrations = new PrismaRunnerRegistrationRepository(prisma);
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
      runnerRegistrations,
      new PrismaAutonomyGrantRepository(prisma),
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

  it('registers a runner at the current protocol version as active, with every declared capability resolved', async () => {
    const response = await post(TENANT_A, validHeartbeatBody('primary')).expect(200);
    expect(response.body).toEqual({
      status: 'active',
      // The intersection with an empty requirement set is the runner's own declared set, not the
      // empty set (review finding) — runner-protocol.md's own words are "the resolved capability
      // set — the intersection", and a runner that declared a capability nothing yet requires must
      // not be told it has zero usable capabilities.
      resolvedCapabilities: ['read_logs'],
      directives: [],
    });

    const stored = await runnerRegistrations.findByName(
      scope(TenantContext.forTrustedInternalUse(TENANT_A), { name: 'primary' }),
    );
    expect(stored).toMatchObject({
      tenantId: TENANT_A,
      name: 'primary',
      status: 'active',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      capabilities: ['read_logs'],
    });
  });

  // Honest limitation, not a tested guarantee (review finding: an earlier version of this test
  // was titled as if the refused path itself were exercised — it was not, and the assertions
  // below still do not exercise it). A real "refused below the compatibility floor" HTTP scenario
  // cannot be constructed today: the floor is two minor versions behind
  // `CURRENT_PROTOCOL_VERSION` (currently 1), and the DTO correctly rejects a negative
  // `protocolVersion` — so no schema-legal wire value is two-plus versions behind. The floor
  // itself is exhaustively unit-tested against higher `currentProtocolVersion` values in
  // `packages/boundary-contract/src/handshake.test.ts`; whether this controller correctly carries
  // a `refused` result (and its `refusedReason`) through to the response and the persisted row is
  // genuinely untested — flagged in QUESTIONS.md rather than claimed here.
  it('an in-range registration is never refused', async () => {
    const response = await post(TENANT_A, validHeartbeatBody('in-range')).expect(200);
    expect(response.body.status).not.toBe('refused');
    expect(response.body).not.toHaveProperty('refusedReason');
  });

  it('a repeat heartbeat for the same (tenant, name) updates the same row, not a second one (FR-020 idempotency)', async () => {
    await post(TENANT_A, validHeartbeatBody('repeat-heartbeat')).expect(200);
    const first = await runnerRegistrations.findByName(
      scope(TenantContext.forTrustedInternalUse(TENANT_A), { name: 'repeat-heartbeat' }),
    );

    await new Promise((resolve) => setTimeout(resolve, 5));
    await post(TENANT_A, validHeartbeatBody('repeat-heartbeat')).expect(200);
    const second = await runnerRegistrations.findByName(
      scope(TenantContext.forTrustedInternalUse(TENANT_A), { name: 'repeat-heartbeat' }),
    );

    expect(second?.id).toBe(first?.id);
    expect(second?.lastHeartbeatAt.getTime()).toBeGreaterThan(first!.lastHeartbeatAt.getTime());
  });

  it('accepts FR-020s resourceState and clockOffsetMs without persisting them (QUESTIONS.md, 012 phase 6)', async () => {
    await post(
      TENANT_A,
      validHeartbeatBody('with-resource-state', {
        resourceState: { activeRuns: 2, cpuPercent: 55 },
        clockOffsetMs: -42,
      }),
    ).expect(200);

    const stored = await runnerRegistrations.findByName(
      scope(TenantContext.forTrustedInternalUse(TENANT_A), { name: 'with-resource-state' }),
    );
    expect(stored).not.toBeNull();
    expect(stored).not.toHaveProperty('resourceState');
    expect(stored).not.toHaveProperty('clockOffsetMs');
  });

  it('a runner whose heartbeat goes silent is exactly what findStaleRunners catches once persisted (FR-020)', async () => {
    await post(TENANT_A, validHeartbeatBody('goes-quiet')).expect(200);
    const stored = await runnerRegistrations.findByName(
      scope(TenantContext.forTrustedInternalUse(TENANT_A), { name: 'goes-quiet' }),
    );
    expect(stored).not.toBeNull();

    // No scheduler exists yet to run this sweep (QUESTIONS.md "012 phase 6, T042") — this proves
    // the persisted row composes correctly with the pure decision function once one does.
    const farFuture = new Date(stored!.lastHeartbeatAt.getTime() + 24 * 60 * 60 * 1000);
    expect(findStaleRunners([stored!], farFuture)).toEqual([stored]);
    expect(findStaleRunners([stored!], stored!.lastHeartbeatAt)).toEqual([]);
  });

  it('rejects a malformed body', async () => {
    await post(TENANT_A, { name: 'bad' }).expect(400);
  });

  it('rejects a heartbeat for a syntactically-valid but unknown tenant, instead of an opaque 500 (review finding)', async () => {
    const unknownTenant = '00000000-0000-0000-8000-00000000dead';
    await post(unknownTenant, validHeartbeatBody('orphan')).expect(404);
  });

  it('never un-revokes a revoked runner — revocation is an admin decision a heartbeat cannot undo (review finding)', async () => {
    const revokedId = randomUUID();
    await query(
      pg,
      `insert into "runner"."runner_registration"
         (id, tenant_id, name, protocol_version, capabilities, image_version, status, last_heartbeat_at)
       values ('${revokedId}', '${TENANT_A}', 'revoked-runner', 1, '{}', '1.0.0', 'revoked', now() - interval '1 day')`,
    );

    await post(TENANT_A, validHeartbeatBody('revoked-runner')).expect(200);

    const stored = await runnerRegistrations.findByName(
      scope(TenantContext.forTrustedInternalUse(TENANT_A), { name: 'revoked-runner' }),
    );
    expect(stored?.status).toBe('revoked');
  });

  it('rejects a missing X-Tenant-Id header', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/runners/heartbeat')
      .send(validHeartbeatBody('no-tenant-header'))
      .expect(400);
  });

  it(
    "a heartbeat for one tenant never becomes visible under another tenant's own lookup " +
      '(tenant isolation, .claude/rules/backend-nestjs.md)',
    () =>
      assertTenantScopedEnqueue(app, 'POST', '/api/v1/runners/heartbeat', {
        tenantA: TENANT_A,
        tenantB: TENANT_B,
        tenantHeader: 'X-Tenant-Id',
        expectStatus: 200,
        bodyFor: (marker) => validHeartbeatBody(marker),
        tenantIdFor: async (marker) => {
          // A direct row read, not the tenant-scoped repository (which cannot answer "which
          // tenant does this belong to" by design) — the same shape as the ingest tenant-isolation
          // test reading a BullMQ job's own `tenantId` field directly.
          const row = await prisma.runnerRegistration.findFirst({ where: { name: marker } });
          return row?.tenantId;
        },
      }),
  );

  it("tenant B registering the exact same runner name never touches tenant A's row (the actual collision case, not just distinct names)", async () => {
    await post(TENANT_A, validHeartbeatBody('shared-name', { imageVersion: '1.0.0' })).expect(200);
    const before = await runnerRegistrations.findByName(
      scope(TenantContext.forTrustedInternalUse(TENANT_A), { name: 'shared-name' }),
    );

    await post(TENANT_B, validHeartbeatBody('shared-name', { imageVersion: '2.0.0' })).expect(200);

    const afterA = await runnerRegistrations.findByName(
      scope(TenantContext.forTrustedInternalUse(TENANT_A), { name: 'shared-name' }),
    );
    const afterB = await runnerRegistrations.findByName(
      scope(TenantContext.forTrustedInternalUse(TENANT_B), { name: 'shared-name' }),
    );
    expect(afterA).toEqual(before);
    expect(afterA?.imageVersion).toBe('1.0.0');
    expect(afterB?.imageVersion).toBe('2.0.0');
    expect(afterA?.id).not.toBe(afterB?.id);
  });
});
