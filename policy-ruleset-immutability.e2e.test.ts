import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PolicyOutcome, PolicyReasonCode, PrismaClient } from '@healer/prisma-client';
import { applySqlFile, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * `policy_ruleset` and `policy_rule` are immutable (002 T005, R-01, data-model.md — "No update
 * path... changed content is a new version"; quickstart 33, a decision must resolve the exact
 * rules of an earlier version forever). Batch 1 (T003) added the triggers; this proves they
 * actually reject a mutation against a real Postgres, through both angles a caller could take —
 * Prisma's typed client and raw SQL — and for both UPDATE and DELETE, on both tables. No
 * repository exists yet for `policy`, so this proves the database itself refuses, not a
 * repository-level guard.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-0000-000000000f20';

describe('policy_ruleset / policy_rule append-only (002 T005, R-01)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let rulesetId: string;
  let ruleId: string;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    prisma = new PrismaClient({ datasourceUrl: pg.url });

    rulesetId = randomUUID();
    ruleId = randomUUID();
    await prisma.policyRuleset.create({
      data: {
        id: rulesetId,
        tenantId: TENANT_ID,
        version: 1,
        digest: 'digest-1',
        publishedAt: new Date('2026-01-01T00:00:00Z'),
        publishedBy: 'test-seed',
        conflictWarnings: {},
      },
    });
    // Minimal schema-valid predicates — not semantically meaningful, and does not need to be:
    // this test proves the database rejects mutation, not that the rule matches anything real.
    await prisma.policyRule.create({
      data: {
        id: ruleId,
        rulesetId,
        ruleKey: 'rule-1',
        predicates: { all: [] },
        outcome: PolicyOutcome.deny,
        reasonCode: PolicyReasonCode.NO_MATCHING_RULE,
        note: 'seed rule',
      },
    });
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('rejects an UPDATE on policy_ruleset through Prisma', async () => {
    await expect(
      prisma.policyRuleset.update({
        where: { id: rulesetId },
        data: { publishedBy: 'changed' },
      }),
    ).rejects.toThrow(/append-only/);
  });

  it('rejects an UPDATE on policy_ruleset through raw SQL', async () => {
    await expect(
      prisma.$executeRaw`UPDATE "policy"."policy_ruleset" SET published_by = 'changed' WHERE id = ${rulesetId}::uuid`,
    ).rejects.toThrow(/append-only/);
  });

  it('rejects a DELETE on policy_ruleset through Prisma', async () => {
    await expect(prisma.policyRuleset.delete({ where: { id: rulesetId } })).rejects.toThrow(
      /append-only/,
    );
  });

  it('rejects a DELETE on policy_ruleset through raw SQL', async () => {
    await expect(
      prisma.$executeRaw`DELETE FROM "policy"."policy_ruleset" WHERE id = ${rulesetId}::uuid`,
    ).rejects.toThrow(/append-only/);
  });

  it('rejects an UPDATE on policy_rule through Prisma', async () => {
    await expect(
      prisma.policyRule.update({ where: { id: ruleId }, data: { note: 'changed' } }),
    ).rejects.toThrow(/append-only/);
  });

  it('rejects an UPDATE on policy_rule through raw SQL', async () => {
    await expect(
      prisma.$executeRaw`UPDATE "policy"."policy_rule" SET note = 'changed' WHERE id = ${ruleId}::uuid`,
    ).rejects.toThrow(/append-only/);
  });

  it('rejects a DELETE on policy_rule through Prisma', async () => {
    await expect(prisma.policyRule.delete({ where: { id: ruleId } })).rejects.toThrow(
      /append-only/,
    );
  });

  it('rejects a DELETE on policy_rule through raw SQL', async () => {
    await expect(
      prisma.$executeRaw`DELETE FROM "policy"."policy_rule" WHERE id = ${ruleId}::uuid`,
    ).rejects.toThrow(/append-only/);
  });

  it('both rows survived every rejected mutation attempt, unchanged', async () => {
    await expect(
      prisma.policyRuleset.findUniqueOrThrow({ where: { id: rulesetId } }),
    ).resolves.toMatchObject({ publishedBy: 'test-seed' });
    await expect(
      prisma.policyRule.findUniqueOrThrow({ where: { id: ruleId } }),
    ).resolves.toMatchObject({ note: 'seed rule' });
  });
});
