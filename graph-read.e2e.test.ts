import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import {
  InvalidGraphFilterError,
  PrismaEdgeProvenanceRepository,
  PrismaGraphReadRepository,
} from '@healer/domain-architecture';
import { NotFoundError, TenantContext, scope } from '@healer/shared';
import { applySqlFile, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * 004 T041 (FR-006, quickstart 2): the node read surface shows class, strength, confidence, the
 * resolvable observation or named actor and the producing run, inside the envelope (R-13).
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT = '00000000-0000-0000-8000-00000000a041';
const OTHER = '00000000-0000-0000-8000-00000000b041';
const ctx = (tenant: string) => TenantContext.forTrustedInternalUse(tenant);

describe('GraphReadRepository (004 T041)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let reads: PrismaGraphReadRepository;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    await prisma.$connect();
    reads = new PrismaGraphReadRepository(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  async function node(
    tenantId: string,
    over: Partial<{
      nodeKind: 'component' | 'repository';
      provenance: 'derived_from_trace' | 'human_authored';
      strength: number;
      state: 'proposed' | 'confirmed';
      validFromVersion: number;
      validToVersion: number;
    }> = {},
  ) {
    const id = randomUUID();
    const human = over.provenance === 'human_authored';
    await prisma.graphNode.create({
      data: {
        id,
        tenantId,
        nodeKind: over.nodeKind ?? 'component',
        layer: 'code',
        name: `name-${id.slice(0, 4)}`,
        naturalKey: id,
        provenance: over.provenance ?? 'derived_from_trace',
        strength: over.strength ?? 50,
        confidence: 77,
        state: over.state ?? 'proposed',
        validFromVersion: over.validFromVersion ?? 1,
        ...(over.validToVersion !== undefined ? { validToVersion: over.validToVersion } : {}),
        observationRef: human ? null : randomUUID(),
        actorRef: human ? 'ana' : null,
        discoveryRunId: human ? null : randomUUID(),
      },
    });
    return id;
  }

  it('a tenant discovery never ran for gets the envelope with never_discovered and no items', async () => {
    const result = await reads.listNodes(scope(ctx(randomUUID()), {}));
    expect(result.confirmationState).toBe('never_discovered');
    expect(result.items).toEqual([]);
    expect(result.graphVersion).toBe(0);
  });

  it('lists nodes with class, stored strength, confidence, observation/actor and run', async () => {
    const machine = await node(TENANT);
    const human = await node(TENANT, { provenance: 'human_authored', strength: 65 });
    const result = await reads.listNodes(scope(ctx(TENANT), {}));
    const byId = new Map(result.items.map((n) => [n.id, n]));
    expect(byId.get(machine)?.provenance).toMatchObject({
      class: 'derived_from_trace',
      strength: 50,
      confidence: 77,
      actorRef: null,
    });
    expect(byId.get(machine)?.provenance.observationRef).toMatch(/^[0-9a-f-]{36}$/);
    expect(byId.get(machine)?.discoveryRunId).toMatch(/^[0-9a-f-]{36}$/);
    expect(byId.get(human)?.provenance).toMatchObject({
      class: 'human_authored',
      observationRef: null,
      actorRef: 'ana',
    });
    expect(result.coverage.nodesTotal).toBeGreaterThanOrEqual(2);
  });

  it('filters by kind, state and minStrength, and rejects a value outside the closed set', async () => {
    const tenant = randomUUID();
    const repo = await node(tenant, { nodeKind: 'repository', strength: 10, state: 'confirmed' });
    await node(tenant, { strength: 50 });
    expect(
      (await reads.listNodes(scope(ctx(tenant), { nodeKind: 'repository' }))).items.map(
        (n) => n.id,
      ),
    ).toEqual([repo]);
    expect((await reads.listNodes(scope(ctx(tenant), { state: 'confirmed' }))).items).toHaveLength(
      1,
    );
    expect((await reads.listNodes(scope(ctx(tenant), { minStrength: 20 }))).items).toHaveLength(1);
    await expect(
      reads.listNodes(scope(ctx(tenant), { nodeKind: 'microservice' })),
    ).rejects.toBeInstanceOf(InvalidGraphFilterError);
  });

  it('resolves a pinned graph version, and states the version it read', async () => {
    const tenant = randomUUID();
    for (const version of [1, 2, 3]) {
      await prisma.graphVersion.create({
        data: {
          id: randomUUID(),
          tenantId: tenant,
          version,
          mintedBy: 'confirmation',
          actorRef: 'ana',
        },
      });
    }
    const early = await node(tenant, { validFromVersion: 1, validToVersion: 1 });
    const late = await node(tenant, { validFromVersion: 3 });
    const current = await reads.listNodes(scope(ctx(tenant), {}));
    expect(current.graphVersion).toBe(3);
    expect(current.items.map((n) => n.id)).toEqual([late]);
    const pinned = await reads.listNodes(scope(ctx(tenant), { graphVersion: 1 }));
    expect(pinned.graphVersion).toBe(1);
    expect(pinned.items.map((n) => n.id)).toEqual([early]);
  });

  it("never lists another tenant's node, and answers its id with NotFoundError", async () => {
    const foreign = await node(OTHER);
    const listed = await reads.listNodes(scope(ctx(TENANT), {}));
    expect(listed.items.map((n) => n.id)).not.toContain(foreign);
    await expect(reads.getNode(scope(ctx(TENANT), { id: foreign }))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('getNode returns the node with its incident edges, every contributing source inspectable', async () => {
    const tenant = randomUUID();
    const [a, b] = [await node(tenant), await node(tenant)];
    const merge = new PrismaEdgeProvenanceRepository(prisma);
    const base = {
      fromNodeId: a,
      toNodeId: b,
      edgeType: 'depends_on',
      layer: 'code' as const,
      adapterVersion: '1',
      observationCount: 30,
      lastObservedAt: new Date('2026-10-01T00:00:00Z'),
      observedUntil: new Date('2026-10-01T00:00:00Z'),
      baseVersion: 1,
    };
    await merge.mergeObservation(
      scope(ctx(tenant), {
        ...base,
        provenance: 'derived_from_code' as const,
        adapterKey: 'ast',
        observationRef: randomUUID(),
      }),
    );
    await merge.mergeObservation(
      scope(ctx(tenant), {
        ...base,
        provenance: 'derived_from_trace' as const,
        adapterKey: 'otel',
        observationRef: randomUUID(),
      }),
    );

    const result = await reads.getNode(scope(ctx(tenant), { id: a }));
    expect(result.items.node.id).toBe(a);
    expect(result.items.edges).toHaveLength(1);
    const edge = result.items.edges[0]!;
    expect(edge.provenance.class).toBe('derived_from_trace');
    expect(edge.provenance.strength).toBe(50);
    expect(edge.provenance.contributingSources.map((s) => s.adapterKey).sort()).toEqual([
      'ast',
      'otel',
    ]);
    expect(edge.observationCount).toBe(60);
  });

  /** `created_at` is the database's own clock (the same one `recorded_at` uses). */
  async function mintVersion(tenantId: string, version: number) {
    await prisma.$executeRaw`
      INSERT INTO "architecture"."graph_version" (id, tenant_id, version, minted_by, actor_ref)
      VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${version}, 'confirmation', 'ana')`;
  }

  it('a pinned read is stable: observations recorded after the version was minted do not change it', async () => {
    const tenant = randomUUID();
    const [a, b] = [await node(tenant), await node(tenant)];
    const merge = new PrismaEdgeProvenanceRepository(prisma);
    const mergeAs = (provenance: 'derived_from_code' | 'derived_from_trace') =>
      merge.mergeObservation(
        scope(ctx(tenant), {
          fromNodeId: a,
          toNodeId: b,
          edgeType: 'depends_on',
          layer: 'code' as const,
          provenance,
          adapterKey: provenance,
          adapterVersion: '1',
          observationRef: randomUUID(),
          observationCount: 30,
          lastObservedAt: new Date('2026-10-01T00:00:00Z'),
          observedUntil: new Date('2026-10-01T00:00:00Z'),
          baseVersion: 1,
        }),
      );
    await mergeAs('derived_from_code');
    await mintVersion(tenant, 1);

    const before = await reads.getNode(scope(ctx(tenant), { id: a, graphVersion: 1 }));
    await mergeAs('derived_from_trace');
    const after = await reads.getNode(scope(ctx(tenant), { id: a, graphVersion: 1 }));

    expect(after).toEqual(before);
    expect(after.items.edges[0]?.provenance.class).toBe('derived_from_code');
    const live = await reads.getNode(scope(ctx(tenant), { id: a }));
    expect(live.items.edges[0]?.provenance.class).toBe('derived_from_trace');
    expect(live.items.edges[0]?.provenance.contributingSources).toHaveLength(2);
  });

  it('shows class, strength, confidence and observation from the SAME (strongest) row; ties break on id', async () => {
    const tenant = randomUUID();
    const [a, b] = [await node(tenant), await node(tenant)];
    const edge = await prisma.graphEdge.create({
      data: {
        id: randomUUID(),
        tenantId: tenant,
        fromNodeId: a,
        toNodeId: b,
        edgeType: 'depends_on',
        layer: 'code',
        provenance: 'derived_from_code',
        strength: 30,
        confidence: 90,
        state: 'proposed',
        validFromVersion: 1,
      },
    });
    const high = { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', ref: randomUUID(), confidence: 90 };
    const low = { id: '00000000-0000-4000-8000-000000000001', ref: randomUUID(), confidence: 55 };
    // One transaction: identical recorded_at, so only the id can break the tie.
    await prisma.$transaction(async (tx) => {
      for (const r of [high, low]) {
        await tx.$executeRaw`
          INSERT INTO "architecture"."edge_provenance"
            (id, tenant_id, edge_id, provenance, strength, confidence, observation_ref, adapter_key,
             adapter_version)
          VALUES (${r.id}::uuid, ${tenant}::uuid, ${edge.id}::uuid, 'derived_from_code', 30,
                  ${r.confidence}, ${r.ref}::uuid, 'ast', '1')`;
      }
    });
    const shown = (await reads.getNode(scope(ctx(tenant), { id: a }))).items.edges[0]!;
    expect(shown.provenance.observationRef).toBe(low.ref);
    expect(shown.provenance.confidence).toBe(low.confidence);
    expect(shown.provenanceUnresolved).toBe(false);
  });

  it('an edge with no provenance row is flagged, not served as if it were sourced', async () => {
    const tenant = randomUUID();
    const [a, b] = [await node(tenant), await node(tenant)];
    await prisma.graphEdge.create({
      data: {
        id: randomUUID(),
        tenantId: tenant,
        fromNodeId: a,
        toNodeId: b,
        edgeType: 'depends_on',
        layer: 'code',
        provenance: 'derived_from_trace',
        strength: 50,
        confidence: 70,
        state: 'proposed',
        validFromVersion: 1,
      },
    });
    const shown = (await reads.getNode(scope(ctx(tenant), { id: a }))).items.edges[0]!;
    expect(shown.provenanceUnresolved).toBe(true);
    expect(shown.provenance.observationRef).toBeNull();
    expect(shown.provenance.contributingSources).toEqual([]);
  });

  it.each([
    ['a graphVersion beyond the current one', { graphVersion: 5 }],
    ['graphVersion 0', { graphVersion: 0 }],
    ['a graphVersion beyond int32', { graphVersion: 2 ** 31 }],
    ['a minStrength beyond smallint', { minStrength: 40_000 }],
    ['a negative minStrength', { minStrength: -1 }],
  ])('rejects %s', async (_name, filter) => {
    const tenant = randomUUID();
    await node(tenant);
    await mintVersion(tenant, 1);
    await expect(reads.listNodes(scope(ctx(tenant), filter))).rejects.toBeInstanceOf(
      InvalidGraphFilterError,
    );
    if ('graphVersion' in filter) {
      await expect(
        reads.getNode(scope(ctx(tenant), { id: randomUUID(), graphVersion: filter.graphVersion })),
      ).rejects.toBeInstanceOf(InvalidGraphFilterError);
    }
  });
});
