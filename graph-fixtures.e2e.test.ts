import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import {
  loadAllFixtures,
  MONOLITH_TENANT_ID,
  MICROSERVICES_TENANT_ID,
  SERVERLESS_TENANT_ID,
  // @ts-expect-error -- plain-JS loader script (004 T004), no .d.ts; see its own file for why it
  // is not written against @healer/domain-architecture or @healer/prisma-client.
} from './scripts/graph-fixtures.mjs';
import { applySqlFile, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * SC-008's actual proof (004 T004, quickstart 15): one query function, called identically against
 * three architecture fixtures — monolith, microservices, serverless — with 0 branches keyed on
 * which fixture it is. `edgeTargets`/`listComponents` below are the whole query set; every `it`
 * calls one of them unchanged and only the expected *data* differs per fixture.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

type GraphEdgeType =
  | 'depends_on'
  | 'calls'
  | 'deploys'
  | 'contains'
  | 'implements'
  | 'exposes'
  | 'serves_feature'
  | 'built_from';

/** Query 1: every component for a tenant (FR-024: always scoped by tenantId). */
async function listComponents(prisma: PrismaClient, tenantId: string): Promise<string[]> {
  const nodes = await prisma.graphNode.findMany({
    where: { tenantId, nodeKind: 'component' },
  });
  return nodes.map((n) => n.name).sort();
}

/**
 * Query 2: what a named node points at over one edge type — covers "what does a component
 * depend on / contain", "which deployment units it deploys to" and "which repositories it is
 * built from" with the same function and the same shape (R-01: edges, not five relationship
 * tables).
 */
async function edgeTargets(
  prisma: PrismaClient,
  tenantId: string,
  fromName: string,
  edgeType: GraphEdgeType,
): Promise<string[]> {
  const fromNode = await prisma.graphNode.findFirstOrThrow({ where: { tenantId, name: fromName } });
  const edges = await prisma.graphEdge.findMany({
    where: { tenantId, fromNodeId: fromNode.id, edgeType },
    include: { toNode: true },
  });
  return edges.map((e) => e.toNode.name).sort();
}

/** Query 3: the runtime kind a deployment unit carries (proves serverless isn't special-cased). */
async function deploymentRuntimeKind(
  prisma: PrismaClient,
  tenantId: string,
  name: string,
): Promise<string> {
  const node = await prisma.graphNode.findFirstOrThrow({ where: { tenantId, name } });
  const attr = await prisma.deploymentUnitAttr.findUniqueOrThrow({ where: { nodeId: node.id } });
  return attr.runtimeKind;
}

describe('one model, three architectures — the SC-008 query set (004 T004)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    await prisma.$connect();
    await loadAllFixtures(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  describe.each([
    ['monolith', MONOLITH_TENANT_ID],
    ['microservices', MICROSERVICES_TENANT_ID],
    ['serverless', SERVERLESS_TENANT_ID],
  ])('%s fixture — same query set, no fixture-specific branch', (_label, tenantId) => {
    it('lists at least one component', async () => {
      const components = await listComponents(prisma, tenantId as string);
      expect(components.length).toBeGreaterThan(0);
    });

    it('every component built_from at least one repository', async () => {
      const components = await listComponents(prisma, tenantId as string);
      for (const name of components) {
        const repos = await edgeTargets(prisma, tenantId as string, name, 'built_from');
        expect(repos.length).toBeGreaterThan(0);
      }
    });

    it('every component deploys to at least one deployment unit', async () => {
      const components = await listComponents(prisma, tenantId as string);
      for (const name of components) {
        const units = await edgeTargets(prisma, tenantId as string, name, 'deploys');
        expect(units.length).toBeGreaterThan(0);
      }
    });
  });

  describe('monolith: n components, contains edges, ONE shared deployment unit (quickstart 13)', () => {
    it('has api, worker and frontend joined by contains edges', async () => {
      expect(await listComponents(prisma, MONOLITH_TENANT_ID)).toEqual([
        'api',
        'frontend',
        'worker',
      ]);
      expect(await edgeTargets(prisma, MONOLITH_TENANT_ID, 'api', 'contains')).toEqual([
        'frontend',
        'worker',
      ]);
    });

    it('every component deploys to the SAME single deployment unit', async () => {
      // This is the assertion that fails if the fixture regresses to three separate units: all
      // three sets below must collapse to one shared name.
      const targets = await Promise.all(
        ['api', 'worker', 'frontend'].map((name) =>
          edgeTargets(prisma, MONOLITH_TENANT_ID, name, 'deploys'),
        ),
      );
      for (const t of targets) expect(t).toEqual(['monolith-app']);
    });

    it('all three components are built_from the one monorepo (quickstart 14)', async () => {
      for (const name of ['api', 'worker', 'frontend']) {
        expect(await edgeTargets(prisma, MONOLITH_TENANT_ID, name, 'built_from')).toEqual([
          'monorepo',
        ]);
      }
    });
  });

  describe('microservices: independent units, and one component built_from two repos (quickstart 14)', () => {
    it('each component deploys to its own, distinct deployment unit', async () => {
      const orders = await edgeTargets(prisma, MICROSERVICES_TENANT_ID, 'orders', 'deploys');
      const payments = await edgeTargets(prisma, MICROSERVICES_TENANT_ID, 'payments', 'deploys');
      const shipping = await edgeTargets(prisma, MICROSERVICES_TENANT_ID, 'shipping', 'deploys');
      expect(orders).toEqual(['orders-du']);
      expect(payments).toEqual(['payments-du']);
      expect(shipping).toEqual(['shipping-du']);
      expect(new Set([...orders, ...payments, ...shipping]).size).toBe(3);
    });

    it('payments is built_from two repositories', async () => {
      expect(await edgeTargets(prisma, MICROSERVICES_TENANT_ID, 'payments', 'built_from')).toEqual([
        'payments-repo',
        'payments-shared-repo',
      ]);
    });

    it('orders calls payments and depends_on shipping', async () => {
      expect(await edgeTargets(prisma, MICROSERVICES_TENANT_ID, 'orders', 'calls')).toEqual([
        'payments',
      ]);
      expect(await edgeTargets(prisma, MICROSERVICES_TENANT_ID, 'orders', 'depends_on')).toEqual([
        'shipping',
      ]);
    });
  });

  describe('serverless: function-runtime units beside a traditional component (quickstart 15)', () => {
    it('mixes container and function runtime kinds with no special-casing', async () => {
      expect(await deploymentRuntimeKind(prisma, SERVERLESS_TENANT_ID, 'checkout-container')).toBe(
        'container',
      );
      expect(await deploymentRuntimeKind(prisma, SERVERLESS_TENANT_ID, 'send-email-function')).toBe(
        'function',
      );
      expect(
        await deploymentRuntimeKind(prisma, SERVERLESS_TENANT_ID, 'resize-image-function'),
      ).toBe('function');
    });

    it('every component still built_from the same repository, same query as the other fixtures', async () => {
      for (const name of ['checkout-api', 'send-email-fn', 'resize-image-fn']) {
        expect(await edgeTargets(prisma, SERVERLESS_TENANT_ID, name, 'built_from')).toEqual([
          'serverless-workloads',
        ]);
      }
    });

    it('checkout-api calls the email function', async () => {
      expect(await edgeTargets(prisma, SERVERLESS_TENANT_ID, 'checkout-api', 'calls')).toEqual([
        'send-email-fn',
      ]);
    });
  });
});
