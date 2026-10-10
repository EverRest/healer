import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import { applySqlFile, startPostgres, type StartedPostgres } from '../../test/containers.js';
import { PrismaTenantEnumerator } from './src/infrastructure/prisma-tenant-enumerator.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));

describe('PrismaTenantEnumerator (T107, C-90)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;

  beforeAll(async () => {
    pg = await startPostgres();
    const names = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    for (const name of names) await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    prisma = new PrismaClient({ datasourceUrl: pg.url });
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('lists active tenants and neither suspended nor deleting ones', async () => {
    const [active, suspended, deleting] = [randomUUID(), randomUUID(), randomUUID()];
    await prisma.tenant.createMany({
      data: [
        { id: active, name: 'a', status: 'active' },
        { id: suspended, name: 's', status: 'suspended' },
        { id: deleting, name: 'd', status: 'deleting' },
      ],
    });
    const ids = await new PrismaTenantEnumerator(prisma).activeTenantIds();
    expect(ids).toContain(active);
    expect(ids).not.toContain(suspended);
    expect(ids).not.toContain(deleting);
  });
});
