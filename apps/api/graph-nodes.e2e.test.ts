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
  PrismaAutonomyGrantRepository,
  PrismaPolicyActionRepository,
  PrismaPolicyDecisionRepository,
  PrismaPolicyRulesetRepository,
} from '@healer/domain-policy';
import { PrismaGraphReadRepository } from '@healer/domain-architecture';
import { PrismaClient } from '@healer/prisma-client';
import { assertTenantIsolated, assertTenantIsolatedList } from '../../test/tenant-isolation.js';
import { applySqlFile, startPostgres, type StartedPostgres } from '../../test/containers.js';
import { configureApiPrefix, createApiModule } from './src/main.js';
import { buildOpenApiDocument } from './src/openapi.js';
import { PrismaRunnerRegistrationRepository } from './src/runners/infrastructure/prisma-runner-registration-repository.js';

/**
 * `GET /graph/nodes` and `GET /graph/nodes/{nodeId}` (004 T041, FR-006, quickstart 2) over real
 * HTTP against real Postgres, plus the tenant-isolation matrix every endpoint needs.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

describe('/graph/nodes (004 T041)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let app: NestExpressApplication;

  const path = (p: string) => `/api/v1${p}`;

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

  async function seedNode(tenantId: string, strength = 50): Promise<string> {
    const id = randomUUID();
    await prisma.graphNode.create({
      data: {
        id,
        tenantId,
        nodeKind: 'component',
        layer: 'code',
        name: 'checkout',
        naturalKey: id,
        provenance: 'derived_from_trace',
        strength,
        confidence: 77,
        state: 'proposed',
        validFromVersion: 1,
        observationRef: randomUUID(),
        discoveryRunId: randomUUID(),
      },
    });
    return id;
  }

  it('lists nodes inside the envelope, each with class, strength, confidence, observation and run', async () => {
    const tenantId = randomUUID();
    const id = await seedNode(tenantId);
    const response = await request(app.getHttpServer())
      .get(path('/graph/nodes'))
      .set('X-Tenant-Id', tenantId)
      .expect(200);
    expect(response.body).toMatchObject({
      graphVersion: 0,
      confirmationState: 'unconfirmed',
      coverage: { nodesTotal: 1, nodesConfirmed: 0 },
    });
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]).toMatchObject({
      id,
      nodeKind: 'component',
      provenance: { class: 'derived_from_trace', strength: 50, confidence: 77, actorRef: null },
    });
    expect(response.body.items[0].provenance.observationRef).toEqual(expect.any(String));
    expect(response.body.items[0].discoveryRunId).toEqual(expect.any(String));
  });

  it('a tenant with no graph still gets the envelope, never a bare array', async () => {
    const response = await request(app.getHttpServer())
      .get(path('/graph/nodes'))
      .set('X-Tenant-Id', randomUUID())
      .expect(200);
    expect(response.body).toMatchObject({ confirmationState: 'never_discovered', items: [] });
  });

  it('filters by minStrength and rejects malformed query values with 400', async () => {
    const tenantId = randomUUID();
    await seedNode(tenantId, 10);
    const strong = await seedNode(tenantId, 50);
    const response = await request(app.getHttpServer())
      .get(path('/graph/nodes?minStrength=20'))
      .set('X-Tenant-Id', tenantId)
      .expect(200);
    expect(response.body.items.map((n: { id: string }) => n.id)).toEqual([strong]);
    for (const query of ['minStrength=abc', 'nodeKind=microservice', 'graphVersion=x']) {
      await request(app.getHttpServer())
        .get(path(`/graph/nodes?${query}`))
        .set('X-Tenant-Id', tenantId)
        .expect(400);
    }
  });

  it('requires a tenant', async () => {
    await request(app.getHttpServer()).get(path('/graph/nodes')).expect(400);
  });

  it('returns one node with its edges; an unknown or malformed id is a 404', async () => {
    const tenantId = randomUUID();
    const id = await seedNode(tenantId);
    const response = await request(app.getHttpServer())
      .get(path(`/graph/nodes/${id}`))
      .set('X-Tenant-Id', tenantId)
      .expect(200);
    expect(response.body.node.id).toBe(id);
    expect(response.body.edges).toEqual([]);
    expect(response.body.confirmationState).toBeDefined();
    for (const missing of [randomUUID(), 'not-a-uuid']) {
      await request(app.getHttpServer())
        .get(path(`/graph/nodes/${missing}`))
        .set('X-Tenant-Id', tenantId)
        .expect(404);
    }
  });

  it('rejects bad query values with 400 that names the offending parameter', async () => {
    const tenantId = randomUUID();
    await seedNode(tenantId);
    const minStrength = await request(app.getHttpServer())
      .get(path('/graph/nodes?minStrength=abc'))
      .set('X-Tenant-Id', tenantId)
      .expect(400);
    expect(minStrength.body.message).toContain('minStrength');
    for (const query of [
      'minStrength=99999',
      'graphVersion=3',
      'graphVersion=0',
      'graphVersion=2147483648',
    ]) {
      await request(app.getHttpServer())
        .get(path(`/graph/nodes?${query}`))
        .set('X-Tenant-Id', tenantId)
        .expect(400);
    }
  });

  it('the detail endpoint accepts graphVersion only: any other parameter is a 400, not ignored', async () => {
    const tenantId = randomUUID();
    const id = await seedNode(tenantId);
    for (const query of [`tenantId=${randomUUID()}`, 'minStrength=10', 'graphVersion=abc']) {
      const response = await request(app.getHttpServer())
        .get(path(`/graph/nodes/${id}?${query}`))
        .set('X-Tenant-Id', tenantId)
        .expect(400);
      expect(response.body.message).toContain(query.split('=')[0]);
    }
    await request(app.getHttpServer())
      .get(path(`/graph/nodes/${id}?graphVersion=99`))
      .set('X-Tenant-Id', tenantId)
      .expect(400);
  });

  it('documents every query parameter in the OpenAPI document, all optional', async () => {
    const document = await buildOpenApiDocument();
    const params = (route: string) =>
      (
        (document.paths[route] as { get: { parameters: { name: string; required?: boolean }[] } })
          .get.parameters ?? []
      ).filter((p) => (p as { in?: string }).in === 'query');
    const list = params('/api/v1/graph/nodes');
    expect(list.map((p) => p.name).sort()).toEqual(
      ['graphVersion', 'layer', 'minStrength', 'nodeKind', 'state'].sort(),
    );
    expect(list.every((p) => p.required === false)).toBe(true);
    const detail = params('/api/v1/graph/nodes/{nodeId}');
    expect(detail.map((p) => p.name)).toEqual(['graphVersion']);
    expect(detail.every((p) => p.required === false)).toBe(true);
  });

  describe('tenant isolation (FR-024)', () => {
    it("GET /graph/nodes: another tenant's node never appears", async () => {
      const tenantId = randomUUID();
      await assertTenantIsolatedList(app, 'GET', '/api/v1/graph/nodes', {
        tenantA: tenantId,
        tenantB: randomUUID(),
        tenantHeader: 'X-Tenant-Id',
        createUnderA: () => seedNode(tenantId),
        responseContainsMarker: (body, marker) =>
          (body as { items: { id: string }[] }).items.some((item) => item.id === marker),
      });
    });

    it("GET /graph/nodes/{nodeId}: another tenant's node returns 404, never 403", async () =>
      assertTenantIsolated(app, 'GET', '/api/v1/graph/nodes/:nodeId', {
        tenantA: randomUUID(),
        tenantB: randomUUID(),
        tenantHeader: 'X-Tenant-Id',
        createUnderTenant: (tenantId) => seedNode(tenantId),
      }));
  });
});
