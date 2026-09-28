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
  type NewIssue,
} from '@healer/domain-issues';
import { PrismaEvidenceRepository, type NewEvidence } from '@healer/domain-evidence';
import { TenantContext, newCorrelationId, scope, withCorrelation } from '@healer/shared';
import { PrismaClient } from '@healer/prisma-client';
import { assertTenantIsolated, assertTenantIsolatedList } from '../../test/tenant-isolation.js';
import { applySqlFile, query, startPostgres, type StartedPostgres } from '../../test/containers.js';
import { configureApiPrefix, createApiModule } from './src/main.js';

/**
 * `GET /issues/{issueId}/evidence` (001 T031, FR-007, SC-004) over real HTTP against a real
 * Postgres — proves the controller's tenant lookup order (issue first, 404 before any evidence
 * query ever runs) and the type filter, neither of which a unit test of `listByIssue` alone can
 * show. The signal queue and delivery repository are noop fakes: nothing here ever hits
 * `POST /ingest/signals`, so a real Redis buys this file nothing.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-8000-0000000000c1';
const ISSUE_ID = '00000000-0000-0000-8000-0000000000c2';
const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);

describe('/issues (001 T031/T040, FR-001, FR-007, FR-020, SC-004)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let app: NestExpressApplication;
  let issues: PrismaIssueRepository;
  let audit: PrismaAuditRepository;

  const get = (issueId: string, tenantId: string, type?: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/issues/${issueId}/evidence${type !== undefined ? `?type=${type}` : ''}`)
      .set('X-Tenant-Id', tenantId);

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    await query(
      pg,
      `insert into "issue"."normalisation_ruleset" (version, rules) values (1, '{}')`,
    );
    await query(
      pg,
      `insert into "issue"."issue"
         (id, tenant_id, kind, environment, severity, state, fingerprint, ruleset_version,
          occurrence_count, first_seen_at, last_seen_at)
       values ('${ISSUE_ID}', '${TENANT_ID}', 'production_incident', 'prod', 'high', 'detected',
               'fp-issues-e2e', 1, 1, now(), now())`,
    );
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    issues = new PrismaIssueRepository(prisma);
    audit = new PrismaAuditRepository(prisma);

    const evidence = new PrismaEvidenceRepository(prisma);
    const newEvidence = (overrides: Partial<NewEvidence> = {}): NewEvidence => ({
      id: randomUUID(),
      issueId: ISSUE_ID,
      type: 'error_signature',
      sourceSystem: 'loki',
      sourceRef: 'ref1',
      sourceLabel: 'from logs',
      excerpt: 'a captured excerpt',
      excerptTruncated: false,
      payload: { exceptionType: 'TypeError' },
      producedByStep: 'collector',
      observedAt: new Date('2026-01-01T00:00:00Z'),
      expiresAt: new Date('2026-02-01T00:00:00Z'),
      ...overrides,
    });
    await withCorrelation(newCorrelationId(), async () => {
      await evidence.record(scope(CONTEXT, newEvidence()));
      await evidence.record(scope(CONTEXT, newEvidence({ type: 'trace_shape' })));
    });

    const ApiModule = createApiModule(
      { service: 'healer-api', version: 'test', build: 'test', runnerProtocolVersion: 1 },
      new BullmqSignalQueue({ url: 'redis://127.0.0.1:6399' }),
      new PrismaIngestionDeliveryRepository(prisma),
      issues,
      evidence,
      audit,
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

  it('returns every evidence record for the issue', async () => {
    const response = await get(ISSUE_ID, TENANT_ID).expect(200);
    expect(response.body.items).toHaveLength(2);
    expect(response.body.items.map((item: { type: string }) => item.type).sort()).toEqual([
      'error_signature',
      'trace_shape',
    ]);
  });

  it('narrows to one type when asked', async () => {
    const response = await get(ISSUE_ID, TENANT_ID, 'trace_shape').expect(200);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]).toMatchObject({ type: 'trace_shape' });
  });

  it('400s on an unrecognized type value', async () => {
    await get(ISSUE_ID, TENANT_ID, 'not-a-real-type').expect(400);
  });

  it('404s for an issue id that does not exist at all', async () => {
    await get(randomUUID(), TENANT_ID).expect(404);
  });

  it("404s another tenant's issue rather than returning an empty list — never falls through to the evidence query", () =>
    assertTenantIsolated(app, 'GET', '/api/v1/issues/:issueId/evidence'));

  function newIssue(overrides: Partial<NewIssue> = {}): NewIssue {
    return {
      id: randomUUID(),
      kind: 'production_incident',
      environment: 'prod',
      severity: 'high',
      fingerprint: `fp-${randomUUID()}`,
      rulesetVersion: 1,
      firstSeenAt: new Date('2026-01-01T00:00:00Z'),
      lastSeenAt: new Date('2026-01-01T00:00:00Z'),
      ...overrides,
    };
  }

  describe('GET /issues/{issueId} (001 T040, FR-020, SC-004)', () => {
    it('returns the full serialized shape, occurrenceCount as a JSON number not a bigint', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/issues/${ISSUE_ID}`)
        .set('X-Tenant-Id', TENANT_ID)
        .expect(200);
      expect(response.body).toMatchObject({
        id: ISSUE_ID,
        kind: 'production_incident',
        state: 'detected',
        occurrenceCount: 1,
        mergedIntoId: null,
        recurrenceOfId: null,
        relatedIssueIds: [],
      });
      expect(typeof response.body.occurrenceCount).toBe('number');
    });

    it('projects a live recurrenceOfId and relatedIssueIds', () =>
      withCorrelation(newCorrelationId(), async () => {
        const resolved = await issues.create(scope(CONTEXT, newIssue()));
        const recurred = await issues.create(
          scope(CONTEXT, newIssue({ recurrenceOf: resolved.id })),
        );
        const correlated = await issues.create(scope(CONTEXT, newIssue()));
        await issues.correlate(
          scope(CONTEXT, {
            id: recurred.id,
            otherId: correlated.id,
            rule: 'component_environment_window',
          }),
        );

        const response = await request(app.getHttpServer())
          .get(`/api/v1/issues/${recurred.id}`)
          .set('X-Tenant-Id', TENANT_ID)
          .expect(200);
        expect(response.body.recurrenceOfId).toBe(resolved.id);
        expect(response.body.relatedIssueIds).toEqual([correlated.id]);
      }));

    it('404s for an issue id that does not exist at all', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/issues/${randomUUID()}`)
        .set('X-Tenant-Id', TENANT_ID)
        .expect(404);
    });

    it("404s another tenant's issue — never 403", () =>
      assertTenantIsolated(app, 'GET', '/api/v1/issues/:issueId'));
  });

  describe('GET /issues (001 T040, FR-001, SC-004)', () => {
    it("lists issues for the caller's tenant, including one created for this suite", async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/issues')
        .set('X-Tenant-Id', TENANT_ID)
        .expect(200);
      expect(response.body.items.map((i: { id: string }) => i.id)).toContain(ISSUE_ID);
    });

    it('narrows by state', () =>
      withCorrelation(newCorrelationId(), async () => {
        const resolved = await issues.create(scope(CONTEXT, newIssue()));
        await issues.transition(scope(CONTEXT, { id: resolved.id }), 'investigating', 'agent', 'x');
        await issues.transition(scope(CONTEXT, { id: resolved.id }), 'resolved', 'human', 'pavlo');

        const response = await request(app.getHttpServer())
          .get('/api/v1/issues?state=resolved')
          .set('X-Tenant-Id', TENANT_ID)
          .expect(200);
        const ids: string[] = response.body.items.map((i: { id: string }) => i.id);
        expect(ids).toContain(resolved.id);
        expect(ids).not.toContain(ISSUE_ID); // ISSUE_ID is still `detected`
      }));

    it('narrows by componentId', () =>
      withCorrelation(newCorrelationId(), async () => {
        const componentId = randomUUID();
        const withComponent = await issues.create(scope(CONTEXT, newIssue({ componentId })));

        const response = await request(app.getHttpServer())
          .get(`/api/v1/issues?componentId=${componentId}`)
          .set('X-Tenant-Id', TENANT_ID)
          .expect(200);
        expect(response.body.items.map((i: { id: string }) => i.id)).toEqual([withComponent.id]);
      }));

    it('narrows by since', () =>
      withCorrelation(newCorrelationId(), async () => {
        // Relative to "now", not a fixed calendar date: ISSUE_ID's own fixture row (`beforeAll`)
        // was inserted with `first_seen_at = now()`, at real test-run time — a hardcoded past
        // date would not actually exclude it the way the test's own comment once assumed.
        const recentCutoff = new Date(Date.now() + 60_000);
        const recent = await issues.create(
          scope(CONTEXT, newIssue({ firstSeenAt: new Date(Date.now() + 120_000) })),
        );

        const response = await request(app.getHttpServer())
          .get(`/api/v1/issues?since=${recentCutoff.toISOString()}`)
          .set('X-Tenant-Id', TENANT_ID)
          .expect(200);
        const ids: string[] = response.body.items.map((i: { id: string }) => i.id);
        expect(ids).toContain(recent.id);
        expect(ids).not.toContain(ISSUE_ID); // ISSUE_ID's firstSeenAt is before the cutoff
      }));

    it('400s on an unrecognized state, a malformed componentId, or an unparsable since', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/issues?state=not-a-real-state')
        .set('X-Tenant-Id', TENANT_ID)
        .expect(400);
      await request(app.getHttpServer())
        .get('/api/v1/issues?componentId=not-a-uuid')
        .set('X-Tenant-Id', TENANT_ID)
        .expect(400);
      await request(app.getHttpServer())
        .get('/api/v1/issues?since=not-a-date')
        .set('X-Tenant-Id', TENANT_ID)
        .expect(400);
    });

    it("never returns another tenant's issues", () =>
      assertTenantIsolatedList(app, 'GET', '/api/v1/issues', {
        tenantA: TENANT_ID,
        tenantB: '00000000-0000-0000-8000-0000000000c9',
        tenantHeader: 'X-Tenant-Id',
        createUnderA: () =>
          withCorrelation(
            newCorrelationId(),
            async () => (await issues.create(scope(CONTEXT, newIssue()))).id,
          ),
        responseContainsMarker: (body, marker) =>
          (body as { items: { id: string }[] }).items.some((item) => item.id === marker),
      }));
  });

  describe('GET /issues/{issueId}/audit (001 T044, FR-012, SC-007, SC-004)', () => {
    it('returns every audit entry for the issue', async () => {
      const entry = await audit.record(
        scope(CONTEXT, {
          id: randomUUID(),
          actorType: 'human',
          actorRef: 'pavlo',
          action: 'issue.close',
          targetType: 'issue',
          targetId: ISSUE_ID,
          reason: 'closing as resolved',
          evidenceIds: [],
          outcome: 'ok',
        }),
      );

      const response = await request(app.getHttpServer())
        .get(`/api/v1/issues/${ISSUE_ID}/audit`)
        .set('X-Tenant-Id', TENANT_ID)
        .expect(200);
      expect(response.body.items.map((i: { id: string }) => i.id)).toContain(entry.id);
    });

    it('resolves an agent-action entry to its prompt version and model identifier (SC-007)', async () => {
      const promptVersionId = randomUUID();
      await query(
        pg,
        `insert into "prompt"."prompt_version" (id, key, digest, body, published_by)
         values ('${promptVersionId}', 'diagnose-issues-e2e', 'digest-issues-e2e', 'body', 'pavlo')`,
      );
      const agentRunId = randomUUID();
      await query(
        pg,
        `insert into "agent"."agent_run"
           (id, tenant_id, correlation_id, agent_kind, prompt_version_id, model_id, provider,
            input_tokens, output_tokens, cost, tool_calls, outcome, started_at)
         values ('${agentRunId}', '${TENANT_ID}', '${randomUUID()}', 'investigator',
                 '${promptVersionId}', 'claude-sonnet-5', 'anthropic', 100, 50, 0.05, '[]', 'ok', now())`,
      );
      const entry = await audit.record(
        scope(CONTEXT, {
          id: randomUUID(),
          actorType: 'agent',
          actorRef: 'investigator',
          action: 'issue.diagnose',
          targetType: 'issue',
          targetId: ISSUE_ID,
          reason: 'diagnosed root cause',
          evidenceIds: [],
          agentRunId,
          outcome: 'ok',
        }),
      );

      const response = await request(app.getHttpServer())
        .get(`/api/v1/issues/${ISSUE_ID}/audit`)
        .set('X-Tenant-Id', TENANT_ID)
        .expect(200);
      const item = response.body.items.find((i: { id: string }) => i.id === entry.id);
      expect(item.agentRunFacts).toEqual({ promptVersionId, modelId: 'claude-sonnet-5' });
    });

    it('404s for an issue id that does not exist at all', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/issues/${randomUUID()}/audit`)
        .set('X-Tenant-Id', TENANT_ID)
        .expect(404);
    });

    it("404s another tenant's issue — never 403", () =>
      assertTenantIsolated(app, 'GET', '/api/v1/issues/:issueId/audit'));
  });
});
