import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import { PrismaNormalisationRulesetRepository } from '@healer/domain-issues';
import { applySqlFile, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * `PrismaNormalisationRulesetRepository` (001 T011, R-01, FR-003): read plus publish only, never
 * update — `publish` always mints the next version, it can never target an existing one. Global,
 * not tenant-scoped: one ruleset governs fingerprinting for every tenant (data-model.md).
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

describe('PrismaNormalisationRulesetRepository (001 T011, R-01, FR-003)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let repo: PrismaNormalisationRulesetRepository;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    repo = new PrismaNormalisationRulesetRepository(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('getByVersion and getLatest return null before anything is published', async () => {
    expect(await repo.getByVersion(1)).toBeNull();
    expect(await repo.getLatest()).toBeNull();
  });

  it('publish mints version 1 for the very first call', async () => {
    const published = await repo.publish({ rules: { strip: ['uuid'] }, note: 'first cut' });
    expect(published).toMatchObject({ version: 1, rules: { strip: ['uuid'] }, note: 'first cut' });
  });

  it('publish mints version 2 next — never version 1 again', async () => {
    const published = await repo.publish({ rules: { strip: ['uuid', 'timestamp'] } });
    expect(published.version).toBe(2);
  });

  it('getByVersion returns the exact historical version, unaffected by later publishes', async () => {
    const v1 = await repo.getByVersion(1);
    expect(v1).toMatchObject({ version: 1, rules: { strip: ['uuid'] }, note: 'first cut' });
  });

  it('getByVersion returns null for a version that was never published', async () => {
    expect(await repo.getByVersion(999)).toBeNull();
  });

  it('getLatest returns the most recently published version', async () => {
    const latest = await repo.getLatest();
    expect(latest).toMatchObject({ version: 2, rules: { strip: ['uuid', 'timestamp'] } });
  });
});
