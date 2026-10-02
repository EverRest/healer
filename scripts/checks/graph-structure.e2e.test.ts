import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../prisma/generated/client/index.js';
import { applySqlFile, startPostgres, type StartedPostgres } from '../../test/containers.js';
import { loadAllFixtures } from '../graph-fixtures.mjs';
import { findGraphStructureViolations } from './graph-structure.mjs';

/**
 * `check:graph-structure` (004 T046/T052 reader): against a real Postgres it passes on the three
 * fixtures and fails on a structurally illegal edge and on a natural_key collision — the
 * production reader of `validateEdge`'s table and of `detectNaturalKeyCollisions`.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));
const migrationNames = (): string[] =>
  readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

const BAD_TENANT = '00000000-0000-0000-a000-0000000000c1';

async function node(prisma: PrismaClient, kind: 'component' | 'repository', name: string) {
  const id = randomUUID();
  await prisma.graphNode.create({
    data: {
      id,
      tenantId: BAD_TENANT,
      nodeKind: kind,
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
}

describe('check:graph-structure against a real Postgres', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames())
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    await prisma.$connect();
    await loadAllFixtures(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('passes on the three architecture fixtures', async () => {
    expect(await findGraphStructureViolations(prisma)).toEqual([]);
  });

  it('names a tenant, an illegal edge and a collision, across tenants', async () => {
    const c1 = await node(prisma, 'component', 'billing');
    const c2 = await node(prisma, 'component', 'Billing');
    const r1 = await node(prisma, 'repository', 'r1');
    const r2 = await node(prisma, 'repository', 'r2');
    const edge = (from: string, to: string, edgeType: 'deploys' | 'built_from') =>
      prisma.graphEdge.create({
        data: {
          id: randomUUID(),
          tenantId: BAD_TENANT,
          fromNodeId: from,
          toNodeId: to,
          edgeType,
          layer: 'code',
          provenance: 'human_authored',
          strength: 65,
          confidence: 100,
          state: 'confirmed',
          validFromVersion: 1,
        },
      });
    await edge(c1, r1, 'deploys'); // illegal: deploys targets a deployment unit
    await edge(c1, r1, 'built_from');
    await edge(c2, r2, 'built_from');

    const violations = await findGraphStructureViolations(prisma);
    expect(violations).toHaveLength(2);
    expect(violations.every((v) => v.includes(BAD_TENANT))).toBe(true);
    expect(violations.some((v) => /deploys/.test(v))).toBe(true);
    expect(violations.some((v) => /billing.*cross_repository/.test(v))).toBe(true);
  });
});
