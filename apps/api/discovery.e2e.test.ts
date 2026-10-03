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
import {
  PrismaDiscoveryRepository,
  PrismaDraftReviewRepository,
  PrismaGraphReadRepository,
} from '@healer/domain-architecture';
import { PrismaClient } from '@healer/prisma-client';
import {
  assertTenantIsolated,
  assertTenantIsolatedList,
  assertTenantScopedEnqueue,
} from '../../test/tenant-isolation.js';
import { applySqlFile, startPostgres, type StartedPostgres } from '../../test/containers.js';
import { PrismaRunnerRegistrationRepository } from './src/runners/infrastructure/prisma-runner-registration-repository.js';
import { configureApiPrefix, createApiModule } from './src/main.js';

/**
 * `POST /discovery/runs`, `GET /discovery/runs`, `GET /discovery/drafts/{draftId}`, `/confirm`,
 * `/reject` over real HTTP against a real Postgres (004 T033, FR-009, FR-010, FR-011). The
 * confirm/reject human-actor gate (FR-010, SC-002) and the supersede rebase themselves are
 * already proven in-process by `confirm-reject-draft-items.e2e.test.ts` — this file proves the
 * HTTP boundary: header → `GraphReviewActor` translation, status codes, and tenant isolation.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_A = '00000000-0000-0000-8000-0000000000e1';
const TENANT_B = '00000000-0000-0000-8000-0000000000e2';

describe('/discovery/* (004 T033, FR-009, FR-010, FR-011)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let app: NestExpressApplication;

  const post = (
    tenantId: string,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    request(app.getHttpServer())
      .post(path)
      .set({ 'X-Tenant-Id': tenantId, 'Idempotency-Key': randomUUID(), ...headers })
      .send(body as object);

  /** Seeds one open draft with one `proposed`, `derived_from_code` `add_node` item under the
   *  given tenant — the minimal fixture `GET`/`confirm`/`reject` each need, built with the real
   *  Prisma client rather than raw SQL for readability; no adapter/collector exists to drive this
   *  through the real `ingestDiscoveryBatch` path without live credentials (see
   *  `discovery-runs.controller.ts`'s own scope note). */
  async function seedDraft(
    tenantId: string,
    itemId: string = randomUUID(),
  ): Promise<{ draftId: string; itemId: string }> {
    const runId = randomUUID();
    const evidenceId = randomUUID();
    const draftId = randomUUID();

    await prisma.discoveryRun.create({
      data: {
        id: runId,
        tenantId,
        baseVersion: 0,
        trigger: 'manual',
        runnerId: 'test-runner',
        startedAt: new Date(),
        finishedAt: new Date(),
      },
    });
    await prisma.evidence.create({
      data: {
        id: evidenceId,
        tenantId,
        issueId: null,
        type: 'graph_fact',
        sourceSystem: 'gitlab',
        sourceRef: runId,
        sourceLabel: 'component observed',
        payload: {},
        producedByStep: 'architecture.discovery',
        observedAt: new Date(),
        expiresAt: new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000),
      },
    });
    await prisma.discoveryDraft.create({
      data: { id: draftId, tenantId, runId, baseVersion: 0, state: 'open' },
    });
    await prisma.draftItem.create({
      data: {
        id: itemId,
        tenantId,
        draftId,
        op: 'add_node',
        proposed: {
          op: 'add_node',
          nodeKind: 'component',
          naturalKey: `svc-${itemId}`,
          name: `svc-${itemId}`,
          attributes: { componentType: 'service', characteristics: [], ownerRef: null },
        },
        proposalDigest: `digest-${itemId}`,
        provenance: 'derived_from_code',
        strength: 30,
        confidence: 60,
        observationRef: evidenceId,
        state: 'proposed',
      },
    });
    return { draftId, itemId };
  }

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
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
      new PrismaApprovalLifecycleRepository(prisma),
      new PrismaGraphReadRepository(prisma),
      new PrismaDiscoveryRepository(prisma),
      new PrismaDraftReviewRepository(prisma),
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

  describe('POST /discovery/runs, GET /discovery/runs (FR-009, FR-022)', () => {
    it("202s a new run and it appears in the tenant's own list", async () => {
      const started = await post(TENANT_A, '/api/v1/discovery/runs', { trigger: 'manual' }).expect(
        202,
      );
      expect(started.body).toMatchObject({ trigger: 'manual', baseVersion: 0 });
      expect(typeof started.body.runId).toBe('string');

      const listed = await request(app.getHttpServer())
        .get('/api/v1/discovery/runs')
        .set('X-Tenant-Id', TENANT_A)
        .expect(200);
      expect(
        listed.body.items.some((item: { runId: string }) => item.runId === started.body.runId),
      ).toBe(true);
    });

    it('rejects a missing X-Tenant-Id header', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/discovery/runs')
        .set('Idempotency-Key', randomUUID())
        .send({ trigger: 'manual' })
        .expect(400);
    });

    it('rejects a malformed body', async () => {
      await post(TENANT_A, '/api/v1/discovery/runs', { trigger: 'not-a-real-trigger' }).expect(422);
    });

    it(
      "a run started for one tenant never appears in another tenant's own list (tenant isolation, " +
        '.claude/rules/backend-nestjs.md)',
      () =>
        assertTenantIsolatedList(app, 'GET', '/api/v1/discovery/runs', {
          tenantA: TENANT_A,
          tenantB: TENANT_B,
          tenantHeader: 'X-Tenant-Id',
          createUnderA: async () => {
            const started = await post(TENANT_A, '/api/v1/discovery/runs', {
              trigger: 'manual',
            }).expect(202);
            return started.body.runId as string;
          },
          responseContainsMarker: (body, marker) =>
            (body as { items: readonly { runId: string }[] }).items.some(
              (item) => item.runId === marker,
            ),
        }),
    );

    it(
      "a run's runnerId never lands under a different tenant's row (tenant isolation, " +
        '.claude/rules/backend-nestjs.md)',
      () =>
        assertTenantScopedEnqueue(app, 'POST', '/api/v1/discovery/runs', {
          tenantA: TENANT_A,
          tenantB: TENANT_B,
          tenantHeader: 'X-Tenant-Id',
          expectStatus: 202,
          bodyFor: (marker) => ({ trigger: 'manual', runnerId: marker }),
          headersFor: () => ({ 'Idempotency-Key': randomUUID() }),
          tenantIdFor: async (marker) => {
            const row = await prisma.discoveryRun.findFirst({ where: { runnerId: marker } });
            return row?.tenantId;
          },
        }),
    );
  });

  describe('GET /discovery/drafts/{draftId} (FR-009, R-07)', () => {
    it('returns the draft as a two-column diff against confirmed state', async () => {
      const { draftId, itemId } = await seedDraft(TENANT_A);

      const response = await request(app.getHttpServer())
        .get(`/api/v1/discovery/drafts/${draftId}`)
        .set('X-Tenant-Id', TENANT_A)
        .expect(200);

      expect(response.body).toMatchObject({ draftId, baseVersion: 0, state: 'open' });
      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0]).toMatchObject({
        id: itemId,
        op: 'add_node',
        state: 'proposed',
        provenance: { class: 'derived_from_code', strength: 30, confidence: 60 },
      });
    });

    it('404s an unknown draft', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/discovery/drafts/${randomUUID()}`)
        .set('X-Tenant-Id', TENANT_A)
        .expect(404);
    });

    it("another tenant's draft 404s, never 403 (tenant isolation, .claude/rules/backend-nestjs.md)", () =>
      assertTenantIsolated(app, 'GET', '/api/v1/discovery/drafts/:draftId', {
        tenantA: TENANT_A,
        tenantB: TENANT_B,
        tenantHeader: 'X-Tenant-Id',
        createUnderTenant: async (tenantId) => (await seedDraft(tenantId)).draftId,
      }));
  });

  describe('POST /discovery/drafts/{draftId}/confirm (FR-010, SC-002)', () => {
    it('confirms with a human actor and mints a graph version', async () => {
      const { draftId, itemId } = await seedDraft(TENANT_A);

      const response = await post(
        TENANT_A,
        `/api/v1/discovery/drafts/${draftId}/confirm`,
        { itemIds: [itemId] },
        { 'X-Actor-Type': 'human', 'X-Actor-Id': 'pavlo' },
      ).expect(200);

      expect(response.body.version).toBe(1);
      expect(response.body.confirmedItems).toEqual([{ itemId, nodeId: expect.any(String) }]);
    });

    it('403s HUMAN_ACTOR_REQUIRED for an agent actor, and audits the refusal (FR-010, SC-002)', async () => {
      const { draftId, itemId } = await seedDraft(TENANT_A);

      const response = await post(
        TENANT_A,
        `/api/v1/discovery/drafts/${draftId}/confirm`,
        { itemIds: [itemId] },
        { 'X-Actor-Type': 'agent', 'X-Actor-Id': 'agent-7', 'X-Agent-Run-Id': randomUUID() },
      ).expect(403);
      expect(response.body.code).toBe('HUMAN_ACTOR_REQUIRED');

      const audited = await prisma.auditEntry.findFirst({
        where: { tenantId: TENANT_A, actorType: 'agent', actorRef: 'agent-7', outcome: 'refused' },
      });
      expect(audited).not.toBeNull();
    });

    it('rejects a confirm with no X-Actor-Type header', async () => {
      const { draftId, itemId } = await seedDraft(TENANT_A);
      await post(TENANT_A, `/api/v1/discovery/drafts/${draftId}/confirm`, {
        itemIds: [itemId],
      }).expect(400);
    });

    it('requires X-Agent-Run-Id when X-Actor-Type is agent', async () => {
      const { draftId, itemId } = await seedDraft(TENANT_A);
      await post(
        TENANT_A,
        `/api/v1/discovery/drafts/${draftId}/confirm`,
        { itemIds: [itemId] },
        { 'X-Actor-Type': 'agent', 'X-Actor-Id': 'agent-7' },
      ).expect(400);
    });

    it(
      "confirming another tenant's draft 404s, never 403 (tenant isolation, " +
        '.claude/rules/backend-nestjs.md)',
      () => {
        // `assertTenantIsolated` sends the identical body to both tenants' requests, so the one
        // real `draft_item` id it needs to exist must be fixed ahead of time rather than returned
        // from `createUnderTenant` (whose own return value is substituted into the path, not the
        // body) — tenant A's own request succeeds because this id is real under its seeded
        // draft; tenant B's identical request 404s on the draft lookup itself, before this id is
        // even considered.
        const itemId = randomUUID();
        return assertTenantIsolated(app, 'POST', '/api/v1/discovery/drafts/:draftId/confirm', {
          tenantA: TENANT_A,
          tenantB: TENANT_B,
          tenantHeader: 'X-Tenant-Id',
          createUnderTenant: async (tenantId) => (await seedDraft(tenantId, itemId)).draftId,
          ownRequestStatus: 200,
          requestHeaders: {
            'Idempotency-Key': randomUUID(),
            'X-Actor-Type': 'human',
            'X-Actor-Id': 'pavlo',
          },
          body: { itemIds: [itemId] },
        });
      },
    );
  });

  describe('POST /discovery/drafts/{draftId}/reject (FR-011)', () => {
    it('rejects with a human actor and a reason, no graph version minted', async () => {
      const { draftId, itemId } = await seedDraft(TENANT_A);

      const response = await post(
        TENANT_A,
        `/api/v1/discovery/drafts/${draftId}/reject`,
        { itemIds: [itemId], reason: 'not a real dependency' },
        { 'X-Actor-Type': 'human', 'X-Actor-Id': 'pavlo' },
      ).expect(200);

      expect(response.body.rejectedItemIds).toEqual([itemId]);
    });

    it('403s a non-human reject', async () => {
      const { draftId, itemId } = await seedDraft(TENANT_A);
      await post(
        TENANT_A,
        `/api/v1/discovery/drafts/${draftId}/reject`,
        { itemIds: [itemId], reason: 'not relevant' },
        { 'X-Actor-Type': 'system', 'X-Actor-Id': 'sweeper' },
      ).expect(403);
    });

    it('422s a reject with no reason', async () => {
      const { draftId, itemId } = await seedDraft(TENANT_A);
      await post(
        TENANT_A,
        `/api/v1/discovery/drafts/${draftId}/reject`,
        { itemIds: [itemId] },
        { 'X-Actor-Type': 'human', 'X-Actor-Id': 'pavlo' },
      ).expect(422);
    });

    it(
      "rejecting another tenant's draft 404s, never 403 (tenant isolation, " +
        '.claude/rules/backend-nestjs.md)',
      () => {
        const itemId = randomUUID();
        return assertTenantIsolated(app, 'POST', '/api/v1/discovery/drafts/:draftId/reject', {
          tenantA: TENANT_A,
          tenantB: TENANT_B,
          tenantHeader: 'X-Tenant-Id',
          createUnderTenant: async (tenantId) => (await seedDraft(tenantId, itemId)).draftId,
          ownRequestStatus: 200,
          requestHeaders: {
            'Idempotency-Key': randomUUID(),
            'X-Actor-Type': 'human',
            'X-Actor-Id': 'pavlo',
          },
          body: { itemIds: [itemId], reason: 'not relevant' },
        });
      },
    );
  });
});
