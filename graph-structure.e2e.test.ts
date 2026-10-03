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
  validateEndpointAttr,
  validateRepositoryAttr,
} from '@healer/domain-architecture';
import { NotFoundError, TenantContext, scope } from '@healer/shared';
import {
  loadAllFixtures,
  microservicesFixture,
  MICROSERVICES_TENANT_ID,
  monolithFixture,
  MONOLITH_TENANT_ID,
  serverlessFixture,
  SERVERLESS_TENANT_ID,
  // @ts-expect-error -- plain-JS loader script (004 T004), no .d.ts
} from './scripts/graph-fixtures.mjs';
import { applySqlFile, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * 004 T048 (SC-008, quickstart 15): the WHOLE query set, run unchanged against all three fixtures.
 * `QUERY_SET` is one list; the loop below has no branch on which fixture it is running. Identical
 * key shapes are asserted across fixtures, and per-kind / per-edge-type counts are asserted against
 * each fixture's own spec — only the data differs. Also T044-T046/T052's infrastructure proofs:
 * every fixture row validates against the vocabulary and kind rules, and every repository method
 * answers a foreign tenant's node id (and a closed or rejected node) with not-found.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));
const migrationNames = (): string[] =>
  readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

interface FixtureSpec {
  tenantId: string;
  nodes: { nodeKind: string }[];
  edges: { edgeType: string }[];
}
const FIXTURE_SPECS = [
  monolithFixture(),
  microservicesFixture(),
  serverlessFixture(),
] as FixtureSpec[];
const FIXTURES = [MONOLITH_TENANT_ID, MICROSERVICES_TENANT_ID, SERVERLESS_TENANT_ID] as string[];
const SCRATCH_TENANT_ID = '00000000-0000-0000-a000-0000000000f4';
const COLLISION_TENANT_ID = '00000000-0000-0000-a000-0000000000f5';
const vocabulary = defaultCharacteristicVocabulary();

type NodeKindName = 'component' | 'deployment_unit' | 'repository' | 'endpoint';
type Query = (
  prisma: PrismaClient,
  repo: PrismaGraphStructureRepository,
  tenantId: string,
) => Promise<unknown>;

const ctx = (tenantId: string) => TenantContext.forTrustedInternalUse(tenantId);
const nodeIdScope = (tenantId: string, nodeId: string) => scope(ctx(tenantId), { nodeId });

async function nodesOfKind(prisma: PrismaClient, tenantId: string, nodeKind: NodeKindName) {
  return prisma.graphNode.findMany({ where: { tenantId, nodeKind }, orderBy: { name: 'asc' } });
}

async function firstNodeId(prisma: PrismaClient, tenantId: string, kind: NodeKindName) {
  const [node] = await nodesOfKind(prisma, tenantId, kind);
  return (node as { id: string }).id;
}

async function seedNode(
  prisma: PrismaClient,
  tenantId: string,
  nodeKind: NodeKindName,
  name: string,
  extra: { state?: 'confirmed' | 'rejected'; validToVersion?: number } = {},
): Promise<string> {
  const id = randomUUID();
  await prisma.graphNode.create({
    data: {
      id,
      tenantId,
      nodeKind,
      layer: 'code',
      name,
      naturalKey: name,
      provenance: 'human_authored',
      strength: 65,
      confidence: 100,
      state: extra.state ?? 'confirmed',
      actorRef: 'fixture',
      validFromVersion: 1,
      ...(extra.validToVersion === undefined ? {} : { validToVersion: extra.validToVersion }),
    },
  });
  return id;
}

async function seedEdge(
  prisma: PrismaClient,
  tenantId: string,
  from: string,
  to: string,
  edgeType: 'deploys' | 'built_from',
) {
  await prisma.graphEdge.create({
    data: {
      id: randomUUID(),
      tenantId,
      fromNodeId: from,
      toNodeId: to,
      edgeType,
      layer: edgeType === 'deploys' ? 'runtime' : 'code',
      provenance: 'human_authored',
      strength: 65,
      confidence: 100,
      state: 'confirmed',
      validFromVersion: 1,
    },
  });
}

const QUERY_SET: Record<string, Query> = {
  components: async (prisma, repo, tenantId) =>
    Promise.all(
      (await nodesOfKind(prisma, tenantId, 'component')).map(async (n) => ({
        name: n.name,
        ...(await repo.getComponentAttr(nodeIdScope(tenantId, n.id))),
      })),
    ),
  deploymentUnits: async (prisma, repo, tenantId) =>
    Promise.all(
      (await nodesOfKind(prisma, tenantId, 'deployment_unit')).map(async (n) => ({
        name: n.name,
        ...(await repo.getDeploymentUnitAttr(nodeIdScope(tenantId, n.id))),
      })),
    ),
  repositories: async (prisma, repo, tenantId) =>
    Promise.all(
      (await nodesOfKind(prisma, tenantId, 'repository')).map(async (n) => ({
        name: n.name,
        ...(await repo.getRepositoryAttr(nodeIdScope(tenantId, n.id))),
      })),
    ),
  endpoints: async (prisma, repo, tenantId) =>
    Promise.all(
      (await nodesOfKind(prisma, tenantId, 'endpoint')).map(async (n) => ({
        name: n.name,
        ...(await repo.getEndpointAttr(nodeIdScope(tenantId, n.id))),
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
  naturalKeyCollisions: (_prisma, repo, tenantId) =>
    repo.listNaturalKeyCollisions(scope(ctx(tenantId), {})),
};
const EMPTY_BY_DESIGN = ['edgeEndpointViolations', 'naturalKeyCollisions'];

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

const count = (items: { [k: string]: string }[], key: string, value: string): number =>
  items.filter((i) => i[key] === value).length;

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

  it.each(Object.keys(QUERY_SET).filter((q) => !EMPTY_BY_DESIGN.includes(q)))(
    '%s: non-empty in every fixture and the same key shape across all three',
    (name) => {
      const rows = FIXTURES.map((t) => results.get(t)?.get(name) as unknown[]);
      for (const r of rows) expect(r.length).toBeGreaterThan(0);
      const [first, ...rest] = rows.map(shapeOf);
      for (const other of rest) expect(other).toEqual(first);
    },
  );

  it('row counts per kind and per structural edge type equal each fixture spec (data-dependent)', () => {
    const queryForKind = {
      component: 'components',
      deployment_unit: 'deploymentUnits',
      repository: 'repositories',
      endpoint: 'endpoints',
    } as const;
    for (const spec of FIXTURE_SPECS) {
      const q = results.get(spec.tenantId);
      for (const [kind, query] of Object.entries(queryForKind))
        expect((q?.get(query) as unknown[]).length, `${spec.tenantId} ${kind}`).toBe(
          spec.nodes.filter((n) => n.nodeKind === kind).length,
        );
      const edges = q?.get('structuralEdges') as { type: string }[];
      for (const type of STRUCTURAL_EDGE_TYPES)
        expect(count(edges, 'type', type), `${spec.tenantId} ${type}`).toBe(
          spec.edges.filter((e) => e.edgeType === type).length,
        );
    }
  });

  it('every fixture has an implements and an exposes edge, and none breaks the endpoint rules', () => {
    for (const t of FIXTURES) {
      const edges = results.get(t)?.get('structuralEdges') as { type: string }[];
      expect(count(edges, 'type', 'implements')).toBeGreaterThan(0);
      expect(count(edges, 'type', 'exposes')).toBeGreaterThan(0);
      expect(results.get(t)?.get('edgeEndpointViolations')).toEqual([]);
      expect(results.get(t)?.get('naturalKeyCollisions')).toEqual([]);
    }
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
      for (const { name: _n, ...attr } of q?.get('endpoints') as { name: string }[])
        expect(validateEndpointAttr(attr).ok).toBe(true);
    }
  });

  describe('tenant isolation of every repository method (FR-024, SC-009)', () => {
    const valid = <T>(r: { ok: true; value: T } | { ok: false; errors: readonly string[] }): T => {
      if (!r.ok) throw new Error(r.errors.join());
      return r.value;
    };
    // One row per kind: how to read it, and how to write a perfectly valid value for it.
    const KINDS = [
      {
        kind: 'component' as const,
        read: (w: ReturnType<typeof nodeIdScope>) => repo.getComponentAttr(w),
        write: (w: ReturnType<typeof nodeIdScope>) =>
          repo.saveComponentAttr(
            w,
            valid(
              validateComponentAttr({ componentType: 'library', characteristics: [] }, vocabulary),
            ),
          ),
      },
      {
        kind: 'deployment_unit' as const,
        read: (w: ReturnType<typeof nodeIdScope>) => repo.getDeploymentUnitAttr(w),
        write: (w: ReturnType<typeof nodeIdScope>) =>
          repo.saveDeploymentUnitAttr(
            w,
            valid(
              validateDeploymentUnitAttr({ environment: 'x', runtimeKind: 'vm', runtimeRef: 'r' }),
            ),
          ),
      },
      {
        kind: 'repository' as const,
        read: (w: ReturnType<typeof nodeIdScope>) => repo.getRepositoryAttr(w),
        write: (w: ReturnType<typeof nodeIdScope>) =>
          repo.saveRepositoryAttr(
            w,
            valid(validateRepositoryAttr({ vcs: 'gitlab', projectRef: 'x/y', defaultBranch: 'z' })),
          ),
      },
      {
        kind: 'endpoint' as const,
        read: (w: ReturnType<typeof nodeIdScope>) => repo.getEndpointAttr(w),
        write: (w: ReturnType<typeof nodeIdScope>) =>
          repo.saveEndpointAttr(w, valid(validateEndpointAttr({ protocol: 'cli' }))),
      },
    ];

    it.each(KINDS.map((k) => [k.kind, k] as const))(
      "%s: tenant B can neither read nor write tenant A's node, and A's row is untouched",
      async (_kind, k) => {
        const id = await firstNodeId(prisma, MONOLITH_TENANT_ID, k.kind);
        const before = await k.read(nodeIdScope(MONOLITH_TENANT_ID, id));
        await expect(k.read(nodeIdScope(SERVERLESS_TENANT_ID, id))).rejects.toBeInstanceOf(
          NotFoundError,
        );
        await expect(k.write(nodeIdScope(SERVERLESS_TENANT_ID, id))).rejects.toBeInstanceOf(
          NotFoundError,
        );
        expect(await k.read(nodeIdScope(MONOLITH_TENANT_ID, id))).toEqual(before);
      },
    );

    it.each(KINDS.map((k) => [k.kind, k] as const))(
      '%s: a write against a node of a different kind is not found',
      async (_kind, k) => {
        const other = KINDS.find((o) => o.kind !== k.kind) as (typeof KINDS)[number];
        const id = await firstNodeId(prisma, MONOLITH_TENANT_ID, other.kind);
        await expect(k.write(nodeIdScope(MONOLITH_TENANT_ID, id))).rejects.toBeInstanceOf(
          NotFoundError,
        );
      },
    );

    it('a valid write by the owning tenant is read back', async () => {
      const where = nodeIdScope(
        MONOLITH_TENANT_ID,
        await firstNodeId(prisma, MONOLITH_TENANT_ID, 'component'),
      );
      const attr = valid(
        validateComponentAttr(
          {
            componentType: 'worker',
            characteristics: ['scheduled', 'stateful'],
            ownerRef: 'team-x',
          },
          vocabulary,
        ),
      );
      await repo.saveComponentAttr(where, attr);
      expect(await repo.getComponentAttr(where)).toEqual(attr);
    });

    it('a closed (superseded) or rejected node cannot be written: not found (review M7)', async () => {
      const attr = valid(
        validateComponentAttr({ componentType: 'job', characteristics: [] }, vocabulary),
      );
      const closed = await seedNode(prisma, SCRATCH_TENANT_ID, 'component', 'closed', {
        validToVersion: 2,
      });
      const rejected = await seedNode(prisma, SCRATCH_TENANT_ID, 'component', 'rejected', {
        state: 'rejected',
      });
      const open = await seedNode(prisma, SCRATCH_TENANT_ID, 'component', 'open');
      for (const id of [closed, rejected])
        await expect(
          repo.saveComponentAttr(nodeIdScope(SCRATCH_TENANT_ID, id), attr),
        ).rejects.toBeInstanceOf(NotFoundError);
      await repo.saveComponentAttr(nodeIdScope(SCRATCH_TENANT_ID, open), attr);
      expect(await repo.getComponentAttr(nodeIdScope(SCRATCH_TENANT_ID, open))).toEqual(attr);
    });

    it('listEdgeEndpointViolations sees only its own tenant', async () => {
      const component = await seedNode(prisma, SCRATCH_TENANT_ID, 'component', 'c');
      const repository = await seedNode(prisma, SCRATCH_TENANT_ID, 'repository', 'r');
      await seedEdge(prisma, SCRATCH_TENANT_ID, component, repository, 'deploys');
      const own = await repo.listEdgeEndpointViolations(scope(ctx(SCRATCH_TENANT_ID), {}));
      expect(own.map((v) => v.edge.type)).toEqual(['deploys']);
      expect(await repo.listEdgeEndpointViolations(scope(ctx(MONOLITH_TENANT_ID), {}))).toEqual([]);
    });

    it('listNaturalKeyCollisions: open, non-rejected components only, own tenant only (review H2/H3)', async () => {
      const r1 = await seedNode(prisma, COLLISION_TENANT_ID, 'repository', 'r1');
      const r2 = await seedNode(prisma, COLLISION_TENANT_ID, 'repository', 'r2');
      const a = await seedNode(prisma, COLLISION_TENANT_ID, 'component', 'billing');
      const b = await seedNode(prisma, COLLISION_TENANT_ID, 'component', 'Billing ');
      await seedNode(prisma, COLLISION_TENANT_ID, 'component', 'billing', { validToVersion: 2 });
      await seedNode(prisma, COLLISION_TENANT_ID, 'component', 'billing', { state: 'rejected' });
      await seedEdge(prisma, COLLISION_TENANT_ID, a, r1, 'built_from');
      await seedEdge(prisma, COLLISION_TENANT_ID, b, r2, 'built_from');
      const own = await repo.listNaturalKeyCollisions(scope(ctx(COLLISION_TENANT_ID), {}));
      expect(own).toHaveLength(1);
      expect(own[0]).toMatchObject({ naturalKey: 'billing', scope: 'cross_repository' });
      expect(own[0]?.candidates.map((c) => c.componentId).sort()).toEqual([a, b].sort());
      expect(await repo.listNaturalKeyCollisions(scope(ctx(MONOLITH_TENANT_ID), {}))).toEqual([]);
    });
  });
});
