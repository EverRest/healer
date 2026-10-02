import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import {
  defaultCharacteristicVocabulary,
  PrismaGraphStructureRepository,
  STRUCTURAL_EDGE_TYPES,
  validateComponentAttr,
  validateDeploymentUnitAttr,
  validateRepositoryAttr,
} from '@healer/domain-architecture';
import { NotFoundError, TenantContext, scope } from '@healer/shared';
import {
  loadAllFixtures,
  MICROSERVICES_TENANT_ID,
  MONOLITH_TENANT_ID,
  SERVERLESS_TENANT_ID,
  // @ts-expect-error -- plain-JS loader script (004 T004), no .d.ts
} from './scripts/graph-fixtures.mjs';
import { applySqlFile, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * 004 T048 (SC-008, quickstart 15): the WHOLE query set, run unchanged against all three fixtures.
 * `QUERY_SET` is one list; the loop below has no branch on which fixture it is running. Identical
 * shapes are asserted across fixtures — only the data differs. Also T044/T045/T046's
 * infrastructure proofs: every fixture row validates against the vocabulary and kind rules, and
 * the repository answers a foreign tenant's node id with not-found.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));
const migrationNames = (): string[] =>
  readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

const FIXTURES = [MONOLITH_TENANT_ID, MICROSERVICES_TENANT_ID, SERVERLESS_TENANT_ID] as string[];
const SCRATCH_TENANT_ID = '00000000-0000-0000-a000-0000000000f4';
const vocabulary = defaultCharacteristicVocabulary();

type Query = (
  prisma: PrismaClient,
  repo: PrismaGraphStructureRepository,
  tenantId: string,
) => Promise<unknown>;

const ctx = (tenantId: string) => TenantContext.forTrustedInternalUse(tenantId);

async function nodesOfKind(
  prisma: PrismaClient,
  tenantId: string,
  nodeKind: 'component' | 'deployment_unit' | 'repository',
) {
  return prisma.graphNode.findMany({ where: { tenantId, nodeKind }, orderBy: { name: 'asc' } });
}

const QUERY_SET: Record<string, Query> = {
  components: async (prisma, repo, tenantId) =>
    Promise.all(
      (await nodesOfKind(prisma, tenantId, 'component')).map(async (n) => ({
        name: n.name,
        ...(await repo.getComponentAttr(scope(ctx(tenantId), { nodeId: n.id }))),
      })),
    ),
  deploymentUnits: async (prisma, repo, tenantId) =>
    Promise.all(
      (await nodesOfKind(prisma, tenantId, 'deployment_unit')).map(async (n) => ({
        name: n.name,
        ...(await repo.getDeploymentUnitAttr(scope(ctx(tenantId), { nodeId: n.id }))),
      })),
    ),
  repositories: async (prisma, repo, tenantId) =>
    Promise.all(
      (await nodesOfKind(prisma, tenantId, 'repository')).map(async (n) => ({
        name: n.name,
        ...(await repo.getRepositoryAttr(scope(ctx(tenantId), { nodeId: n.id }))),
      })),
    ),
  structuralEdges: async (prisma, _repo, tenantId) =>
    (
      await prisma.graphEdge.findMany({
        where: { tenantId, edgeType: { in: [...STRUCTURAL_EDGE_TYPES] } },
        include: { fromNode: true, toNode: true },
      })
    ).map((e) => ({ type: e.edgeType, from: e.fromNode.name, to: e.toNode.name })),
  edgeEndpointViolations: (_prisma, repo, tenantId) =>
    repo.listEdgeEndpointViolations(scope(ctx(tenantId), {})),
};

/** Key structure only: objects by sorted keys, row lists by the union of their rows, leaves opaque. */
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) {
    const rows = value.filter((v) => v !== null && typeof v === 'object');
    if (rows.length === 0) return 'list';
    const merged: Record<string, unknown> = {};
    for (const row of rows) Object.assign(merged, shapeOf(row) as object);
    return [merged];
  }
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, shapeOf(v)]),
    );
  return 'leaf';
}

describe('one query set, three architectures (004 T048, SC-008)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let repo: PrismaGraphStructureRepository;
  const results = new Map<string, Map<string, unknown>>();

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames())
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    await prisma.$connect();
    await loadAllFixtures(prisma);
    repo = new PrismaGraphStructureRepository(prisma);
    for (const tenantId of FIXTURES) {
      const perQuery = new Map<string, unknown>();
      for (const [name, query] of Object.entries(QUERY_SET))
        perQuery.set(name, await query(prisma, repo, tenantId));
      results.set(tenantId, perQuery);
    }
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it.each(Object.keys(QUERY_SET).filter((q) => q !== 'edgeEndpointViolations'))(
    '%s returns rows in every fixture with the identical shape',
    (name) => {
      const shapes = FIXTURES.map((t) => results.get(t)?.get(name));
      for (const rows of shapes) expect((rows as unknown[]).length).toBeGreaterThan(0);
      const [first, ...rest] = shapes.map(shapeOf);
      for (const other of rest) expect(other).toEqual(first);
    },
  );

  it('no fixture has an edge that breaks the structural endpoint rules', () => {
    for (const t of FIXTURES) expect(results.get(t)?.get('edgeEndpointViolations')).toEqual([]);
  });

  it('every fixture attribute row is valid under the vocabulary and kind rules (no style, no unknown term)', () => {
    for (const t of FIXTURES) {
      const q = results.get(t);
      for (const { name: _n, ...attr } of q?.get('components') as { name: string }[])
        expect(validateComponentAttr(attr, vocabulary), JSON.stringify(attr)).toMatchObject({
          ok: true,
        });
      for (const { name: _n, ...attr } of q?.get('deploymentUnits') as { name: string }[])
        expect(validateDeploymentUnitAttr(attr).ok).toBe(true);
      for (const { name: _n, ...attr } of q?.get('repositories') as { name: string }[])
        expect(validateRepositoryAttr(attr).ok).toBe(true);
    }
  });

  describe('tenant isolation of the repository (FR-024, SC-009)', () => {
    it("another tenant's node id is not found, for reads and for writes", async () => {
      const [monolithNode] = await nodesOfKind(prisma, MONOLITH_TENANT_ID, 'component');
      const foreign = scope(ctx(SERVERLESS_TENANT_ID), {
        nodeId: (monolithNode as { id: string }).id,
      });
      await expect(repo.getComponentAttr(foreign)).rejects.toBeInstanceOf(NotFoundError);
      const attr = validateComponentAttr(
        { componentType: 'service', characteristics: [] },
        vocabulary,
      );
      if (!attr.ok) throw new Error('fixture attr invalid');
      await expect(repo.saveComponentAttr(foreign, attr.value)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it('a node of the wrong kind is not found for a kind attribute write', async () => {
      const [unit] = await nodesOfKind(prisma, MONOLITH_TENANT_ID, 'deployment_unit');
      const attr = validateComponentAttr(
        { componentType: 'service', characteristics: [] },
        vocabulary,
      );
      if (!attr.ok) throw new Error('attr invalid');
      await expect(
        repo.saveComponentAttr(
          scope(ctx(MONOLITH_TENANT_ID), { nodeId: (unit as { id: string }).id }),
          attr.value,
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('a valid write by the owning tenant is read back', async () => {
      const [component] = await nodesOfKind(prisma, MONOLITH_TENANT_ID, 'component');
      const where = scope(ctx(MONOLITH_TENANT_ID), { nodeId: (component as { id: string }).id });
      const attr = validateComponentAttr(
        { componentType: 'worker', characteristics: ['scheduled', 'stateful'], ownerRef: 'team-x' },
        vocabulary,
      );
      if (!attr.ok) throw new Error('attr invalid');
      await repo.saveComponentAttr(where, attr.value);
      expect(await repo.getComponentAttr(where)).toEqual(attr.value);
    });

    it('listEdgeEndpointViolations sees only its own tenant', async () => {
      const mk = async (nodeKind: 'component' | 'repository', name: string) => {
        const id = randomUUID();
        await prisma.graphNode.create({
          data: {
            id,
            tenantId: SCRATCH_TENANT_ID,
            nodeKind,
            layer: 'code',
            name,
            naturalKey: name,
            provenance: 'human_authored',
            strength: 65,
            confidence: 100,
            state: 'confirmed',
            actorRef: 'fixture',
            validFromVersion: 1,
          },
        });
        return id;
      };
      const [component, repository] = [await mk('component', 'c'), await mk('repository', 'r')];
      await prisma.graphEdge.create({
        data: {
          id: randomUUID(),
          tenantId: SCRATCH_TENANT_ID,
          fromNodeId: component,
          toNodeId: repository,
          edgeType: 'deploys',
          layer: 'runtime',
          provenance: 'human_authored',
          strength: 65,
          confidence: 100,
          state: 'confirmed',
          validFromVersion: 1,
        },
      });
      const own = await repo.listEdgeEndpointViolations(scope(ctx(SCRATCH_TENANT_ID), {}));
      expect(own.map((v) => v.edge.type)).toEqual(['deploys']);
      expect(await repo.listEdgeEndpointViolations(scope(ctx(MONOLITH_TENANT_ID), {}))).toEqual([]);
    });
  });
});
