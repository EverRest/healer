import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import {
  getSystemContext,
  PrismaSystemContextRepository,
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
      const { items, graphVersion } = results.get(spec.tenantId) as {
        items: SystemContext;
        graphVersion: number;
      };
      const kinds = (k: string) => spec.nodes.filter((n) => n.nodeKind === k).length;
      expect(graphVersion).toBeGreaterThanOrEqual(0);
      expect(items.components).toHaveLength(kinds('component'));
      expect(items.deploymentUnits).toHaveLength(kinds('deployment_unit'));
      expect(items.repositories).toHaveLength(kinds('repository'));
      // Edges to or from an endpoint node fall outside the context's four node lists.
      const endpointNames = new Set(
        (spec.nodes as { nodeKind: string; name?: string }[])
          .filter((n) => n.nodeKind === 'endpoint')
          .map((n) => n.name),
      );
      expect(items.edges).toHaveLength(
        spec.edges.filter((e) => !endpointNames.has(e.from) && !endpointNames.has(e.to)).length,
      );
      expect(items.components.every((c) => c.attributes.componentType.length > 0)).toBe(true);
      expect(items.characteristics).toEqual(
        [...new Set(items.components.flatMap((c) => c.attributes.characteristics))].sort(),
      );
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

  it('leaves a rejected element and its edges out of the context', async () => {
    const make = (name: string, state: 'confirmed' | 'rejected') =>
      prisma.graphNode
        .create({
          data: {
            id: randomUUID(),
            tenantId: SCRATCH_TENANT_ID,
            nodeKind: 'component',
            layer: 'code',
            name,
            naturalKey: name,
            provenance: 'human_authored',
            strength: 65,
            confidence: 100,
            state,
            actorRef: 'fixture',
            validFromVersion: 1,
          },
        })
        .then(async (n) => {
          await prisma.componentAttr.create({
            data: { nodeId: n.id, tenantId: SCRATCH_TENANT_ID, componentType: 'service' },
          });
          return n.id;
        });
    const kept = await make('kept', 'confirmed');
    const dropped = await make('dropped', 'rejected');
    await prisma.graphEdge.create({
      data: {
        id: randomUUID(),
        tenantId: SCRATCH_TENANT_ID,
        fromNodeId: kept,
        toNodeId: dropped,
        edgeType: 'depends_on',
        layer: 'code',
        provenance: 'human_authored',
        strength: 65,
        confidence: 100,
        state: 'confirmed',
        validFromVersion: 1,
      },
    });
    const { items } = await getSystemContext(repo, ctx(SCRATCH_TENANT_ID));
    expect(items.components.map((c) => c.name)).toEqual(['kept']);
    expect(items.edges).toEqual([]);
  });
});
