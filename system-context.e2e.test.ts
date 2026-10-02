import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import {
  getSystemContext,
  PrismaSystemContextRepository,
  SystemContextInvariantError,
  type SystemContext,
} from '@healer/domain-architecture';
import { TenantContext } from '@healer/shared';
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
 * 004 T049 (FR-020, SC-008, quickstart 16): `GetSystemContext` against the three architecture
 * fixtures. One call, no branch on which fixture it is; the result carries the same key shape for
 * all three and no key anywhere that names a style. Tenant isolation: another tenant's graph is
 * never visible.
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
  edges: { edgeType: string; from: string; to: string }[];
}
const SPECS = [monolithFixture(), microservicesFixture(), serverlessFixture()] as FixtureSpec[];
const SCRATCH_TENANT_ID = '00000000-0000-0000-a000-0000000000f6';
const EMPTY_TENANT_ID = '00000000-0000-0000-a000-0000000000f7';
const ctx = (tenantId: string) => TenantContext.forTrustedInternalUse(tenantId);

/** Every key path in the value, row lists merged — structure only, leaves opaque. */
function keyPaths(value: unknown, prefix = '', into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const row of value) keyPaths(row, `${prefix}[]`, into);
  else if (value !== null && typeof value === 'object' && !(value instanceof Date))
    for (const [k, v] of Object.entries(value)) {
      into.add(`${prefix}.${k}`);
      keyPaths(v, `${prefix}.${k}`, into);
    }
  return into;
}

describe('GetSystemContext (004 T049, FR-020)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let repo: PrismaSystemContextRepository;
  const results = new Map<string, Awaited<ReturnType<typeof getSystemContext>>>();

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames())
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    await prisma.$connect();
    await loadAllFixtures(prisma);
    repo = new PrismaSystemContextRepository(prisma);
    for (const spec of SPECS)
      results.set(spec.tenantId, await getSystemContext(repo, ctx(spec.tenantId)));
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('carries every component, deployment unit, repository and edge between them, per fixture', () => {
    for (const spec of SPECS) {
      const result = results.get(spec.tenantId) as Awaited<ReturnType<typeof getSystemContext>>;
      const { items } = result;
      const kinds = (k: string) => spec.nodes.filter((n) => n.nodeKind === k).length;
      expect(result.graphVersion).toBe(1);
      expect(items.components).toHaveLength(kinds('component'));
      expect(items.deploymentUnits).toHaveLength(kinds('deployment_unit'));
      expect(items.repositories).toHaveLength(kinds('repository'));
      // Edges to or from an endpoint node fall outside the context's three node lists.
      const endpointNames = new Set(
        (spec.nodes as { nodeKind: string; name?: string }[])
          .filter((n) => n.nodeKind === 'endpoint')
          .map((n) => n.name),
      );
      const inContext = spec.edges.filter(
        (e) => !endpointNames.has(e.from) && !endpointNames.has(e.to),
      );
      expect(items.edges).toHaveLength(inContext.length);
      expect(items.excludedEdges).toBe(spec.edges.length - inContext.length);
      expect(items.excludedEdges).toBeGreaterThan(0);
      expect(items.components.every((c) => c.attributes.componentType.length > 0)).toBe(true);
      // Against the fixture's own spec, not a recomputation over the result.
      const wanted = new Set(
        (spec.nodes as { nodeKind: string; characteristics?: string[] }[]).flatMap((n) =>
          n.nodeKind === 'component' ? (n.characteristics ?? []) : [],
        ),
      );
      expect(items.characteristics).toEqual([...wanted].sort());
      // Every fixture row is confirmed: coverage is context-scoped and complete.
      expect(result.confirmationState).toBe('confirmed');
      expect(result.coverage).toEqual({
        nodesConfirmed:
          items.components.length + items.deploymentUnits.length + items.repositories.length,
        nodesTotal:
          items.components.length + items.deploymentUnits.length + items.repositories.length,
        edgesConfirmed: inContext.length,
        edgesTotal: inContext.length,
      });
    }
  });

  it('has the identical key shape across the three architectures and no style key anywhere', () => {
    const shapes = SPECS.map((s) => [...keyPaths(results.get(s.tenantId))].sort());
    expect(shapes[1]).toEqual(shapes[0]);
    expect(shapes[2]).toEqual(shapes[0]);
    const forbidden = /style|architecture|monolith|microservice|serverless|systemkind|topology/i;
    expect(shapes[0]?.filter((p) => forbidden.test(p))).toEqual([]);
  });

  it("never shows another tenant's graph, and states never_discovered for a tenant with none", async () => {
    const own = results.get(MONOLITH_TENANT_ID)?.items as SystemContext;
    const ids = new Set(
      [...own.components, ...own.deploymentUnits, ...own.repositories].map((n) => n.id),
    );
    for (const other of [MICROSERVICES_TENANT_ID, SERVERLESS_TENANT_ID]) {
      const theirs = results.get(other)?.items as SystemContext;
      const theirIds = [...theirs.components, ...theirs.deploymentUnits, ...theirs.repositories];
      expect(theirIds.some((n) => ids.has(n.id))).toBe(false);
      expect(theirs.edges.some((e) => ids.has(e.fromNodeId) || ids.has(e.toNodeId))).toBe(false);
    }
    const empty = await getSystemContext(repo, ctx(EMPTY_TENANT_ID));
    expect(empty.confirmationState).toBe('never_discovered');
    expect(empty.items.components).toEqual([]);
    expect(empty.items.edges).toEqual([]);
  });

  const seedNode = (
    tenantId: string,
    name: string,
    over: { state?: 'confirmed' | 'rejected'; from?: number; to?: number; attr?: boolean } = {},
  ) =>
    prisma.graphNode
      .create({
        data: {
          id: randomUUID(),
          tenantId,
          nodeKind: 'component',
          layer: 'code',
          name,
          naturalKey: name,
          provenance: 'human_authored',
          strength: 65,
          confidence: 100,
          state: over.state ?? 'confirmed',
          actorRef: 'fixture',
          validFromVersion: over.from ?? 1,
          ...(over.to === undefined ? {} : { validToVersion: over.to }),
        },
      })
      .then(async (n) => {
        if (over.attr !== false)
          await prisma.componentAttr.create({
            data: { nodeId: n.id, tenantId, componentType: 'service' },
          });
        return n.id;
      });
  const seedEdge = (
    tenantId: string,
    from: string,
    to: string,
    state: 'confirmed' | 'rejected' = 'confirmed',
  ) =>
    prisma.graphEdge.create({
      data: {
        id: randomUUID(),
        tenantId,
        fromNodeId: from,
        toNodeId: to,
        edgeType: 'depends_on',
        layer: 'code',
        provenance: 'human_authored',
        strength: 65,
        confidence: 100,
        state,
        validFromVersion: 1,
      },
    });

  it('leaves a rejected element and its edges out of the context, counting what was dropped', async () => {
    const kept = await seedNode(SCRATCH_TENANT_ID, 'kept');
    const kept2 = await seedNode(SCRATCH_TENANT_ID, 'kept2');
    const dropped = await seedNode(SCRATCH_TENANT_ID, 'dropped', { state: 'rejected' });
    await seedEdge(SCRATCH_TENANT_ID, kept, dropped);
    await seedEdge(SCRATCH_TENANT_ID, kept, kept2, 'rejected'); // between two live nodes
    const { items } = await getSystemContext(repo, ctx(SCRATCH_TENANT_ID));
    expect(items.components.map((c) => c.name)).toEqual(['kept', 'kept2']);
    expect(items.edges).toEqual([]); // the rejected edge is excluded by its own state
    expect(items.excludedEdges).toBe(1); // the edge to the rejected node; a rejected edge is not counted
  });

  it('shows only the rows valid at the current version', async () => {
    const T = '00000000-0000-0000-a000-0000000000f8';
    for (const version of [1, 2])
      await prisma.graphVersion.create({
        data: {
          id: randomUUID(),
          tenantId: T,
          version,
          mintedBy: 'confirmation',
          actorRef: 'fixture',
        },
      });
    const live = await seedNode(T, 'live', { from: 1 });
    await seedNode(T, 'closed-at-1', { from: 1, to: 1 });
    await seedNode(T, 'future', { from: 3 });
    const live2 = await seedNode(T, 'live2', { from: 2 });
    await seedEdge(T, live, live2);
    const result = await getSystemContext(repo, ctx(T));
    expect(result.graphVersion).toBe(2);
    expect(result.items.components.map((c) => c.name)).toEqual(['live', 'live2']);
    expect(result.items.edges).toHaveLength(1);
  });

  it('names the tenant and node when a node has no attribute row', async () => {
    const T = '00000000-0000-0000-a000-0000000000f9';
    const id = await seedNode(T, 'no-attr', { attr: false });
    const error = await getSystemContext(repo, ctx(T)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SystemContextInvariantError);
    expect(error).toMatchObject({ tenantId: T, nodeId: id });
  });
});
