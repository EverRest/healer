import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BullmqSignalQueue,
  PrismaIngestionDeliveryRepository,
  PrismaIssueRepository,
} from '@healer/domain-issues';
import { PrismaEvidenceRepository, type NewEvidence } from '@healer/domain-evidence';
import { TenantContext, newCorrelationId, scope, withCorrelation } from '@healer/shared';
import { PrismaClient } from '@healer/prisma-client';
import { assertTenantIsolated } from '../../test/tenant-isolation.js';
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

describe('GET /issues/{issueId}/evidence (001 T031, FR-007, SC-004)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let app: NestExpressApplication;

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
      new PrismaIssueRepository(prisma),
      evidence,
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
});
