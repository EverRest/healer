import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../prisma/generated/client/index.js';
import { applySqlFile, startPostgres, type StartedPostgres } from '../../test/containers.js';
import { allDeclaredTriggers, findLiveViolations } from './append-only.mjs';

/**
 * `check:append-only`'s real, live-database query (001 T034, SC-003) — unit-tested against a
 * fake trigger catalogue in `append-only.test.ts`, proven here against a real Postgres with the
 * actual migrations applied, since a mistake in the SQL itself (a wrong catalogue column, a
 * schema this Postgres version doesn't have) would pass every unit test and still be wrong.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

describe('check:append-only against a real Postgres (001 T034, SC-003)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    prisma = new PrismaClient({ datasourceUrl: pg.url });
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('finds zero violations right after every migration has run', async () => {
    const declared = allDeclaredTriggers();
    expect(declared.length).toBeGreaterThan(0);
    expect(await findLiveViolations(prisma, declared)).toEqual([]);
  });

  it('catches a trigger that was silently disabled — exactly the class of drift this check exists for', async () => {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "evidence"."evidence" DISABLE TRIGGER evidence_append_only`,
    );
    try {
      const violations = await findLiveViolations(prisma);
      expect(violations).toContain(
        'evidence.evidence: trigger evidence_append_only is missing or disabled',
      );
    } finally {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "evidence"."evidence" ENABLE TRIGGER evidence_append_only`,
      );
    }
  });
});
