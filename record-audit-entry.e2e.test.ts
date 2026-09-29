import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import { recordAuditEntry, type NewAuditEntry } from '@healer/domain-policy';
import { TenantContext, scope } from '@healer/shared';
import { applySqlFile, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * `recordAuditEntry` (002 T017, FR-012, FR-020) — the shared "write `audit_entry` in the same
 * transaction" helper for command handlers this batch does not build (T019, T039, T045, ...).
 * No caller exists yet, so this proves the mechanism directly, the same way
 * `audit-repository.e2e.test.ts` (001 T042/T043) proved `PrismaAuditRepository` before 002
 * existed: a fake command writes a throwaway `policy_ruleset` row in the same transaction, and a
 * forced rollback of that write must take the audit entry down with it — proving atomicity, not
 * just that the insert statement runs.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-8000-0000000000a1';
const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);

function newEntry(overrides: Partial<NewAuditEntry> = {}): NewAuditEntry {
  return {
    id: randomUUID(),
    actorType: 'human',
    actorRef: 'pavlo',
    action: 'policy.publish_ruleset',
    targetType: 'policy_ruleset',
    targetId: randomUUID(),
    reason: 'batch 4 fake command',
    evidenceIds: [],
    outcome: 'ok',
    ...overrides,
  };
}

/** A throwaway co-located write standing in for the state change a real command would make.
 * `version` must be distinct per call — `(tenant_id, version)` is unique — so each test picks
 * its own, distinguishable in a failure by its digest. */
function newRulesetRow(id: string, version: number) {
  return {
    id,
    tenantId: TENANT_ID,
    version,
    digest: `digest-${id}`,
    publishedAt: new Date('2026-01-01T00:00:00Z'),
    publishedBy: 'test-seed',
    conflictWarnings: {},
  };
}

class ForcedRollback extends Error {}

describe('recordAuditEntry (002 T017)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    // No FK from policy_ruleset/audit_entry to tenant.tenant (data-model.md: tenant_id is a
    // plain scoping column, enforced at the query layer, not by a foreign key) — no tenant row
    // needs to exist for this test.
    prisma = new PrismaClient({ datasourceUrl: pg.url });
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('commits the audit entry in the same transaction as a co-located write', async () => {
    const rulesetId = randomUUID();
    const entry = newEntry({ targetId: rulesetId });

    await prisma.$transaction(async (tx) => {
      await tx.policyRuleset.create({ data: newRulesetRow(rulesetId, 1) });
      await recordAuditEntry(tx, scope(CONTEXT, entry));
    });

    const ruleset = await prisma.policyRuleset.findUnique({ where: { id: rulesetId } });
    const audit = await prisma.auditEntry.findUnique({ where: { id: entry.id } });
    expect(ruleset).not.toBeNull();
    expect(audit).toMatchObject({ id: entry.id, tenantId: TENANT_ID, targetId: rulesetId });
  });

  it('rolls back the audit entry when the co-located write is rolled back', async () => {
    const rulesetId = randomUUID();
    const entry = newEntry({ targetId: rulesetId });

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.policyRuleset.create({ data: newRulesetRow(rulesetId, 2) });
        await recordAuditEntry(tx, scope(CONTEXT, entry));
        throw new ForcedRollback('simulated failure after both writes');
      }),
    ).rejects.toThrow(ForcedRollback);

    const ruleset = await prisma.policyRuleset.findUnique({ where: { id: rulesetId } });
    const audit = await prisma.auditEntry.findUnique({ where: { id: entry.id } });
    expect(ruleset).toBeNull();
    expect(audit).toBeNull();
  });
});
