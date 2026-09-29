import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PolicyOutcome, PrismaClient } from '@healer/prisma-client';
import { applySqlFile, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * `policy_decision.consumed_at` and `.invalidated_reason` are mutually exclusive terminal
 * branches (data-model.md "State transitions" — `issued` moves to `consumed` OR `invalidated`,
 * never both; SC-001's reconciliation invariant needs a decision to be unambiguously "was this
 * executed or not"). Found by review after batch 1 (T002/T003): the append-only trigger checked
 * each column independently, so a row could end up with both set, either in one statement or
 * across two sequential UPDATEs, and an INSERT setting both from the start bypassed the trigger
 * entirely (it only fires on UPDATE/DELETE). Fixed with a table CHECK constraint, which covers
 * INSERT and UPDATE in one mechanism. This proves the constraint fires on all three angles.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-0000-000000000f21';

function decisionData(id: string) {
  return {
    id,
    tenantId: TENANT_ID,
    actionKey: 'change.open_pull_request',
    proposalDigest: 'digest-1',
    decisionInput: {},
    rulesetVersion: 1,
    outcome: PolicyOutcome.allow,
    ceilingApplied: false,
    budgetState: {},
    evaluatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

describe('policy_decision consumed/invalidated mutual exclusion (post-batch-1 fix, R-14, SC-001)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    prisma = new PrismaClient({ datasourceUrl: pg.url });
  }, 180_000);

  // policy_decision is append-only (T003) — DELETE is always rejected, even from the tests'
  // own cleanup, so each test gets a fresh randomUUID() row rather than a truncated table
  // between tests. The container itself is disposable and stopped in afterAll.
  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('rejects an INSERT that sets both consumed_at and invalidated_reason', async () => {
    await expect(
      prisma.policyDecision.create({
        data: {
          ...decisionData(randomUUID()),
          consumedAt: new Date('2026-01-01T00:01:00Z'),
          invalidatedReason: 'epoch_bump',
        },
      }),
    ).rejects.toThrow(/policy_decision_terminal_xor/);
  });

  it('rejects an UPDATE that sets both columns from null in one statement', async () => {
    const id = randomUUID();
    await prisma.policyDecision.create({ data: decisionData(id) });

    await expect(
      prisma.policyDecision.update({
        where: { id },
        data: {
          consumedAt: new Date('2026-01-01T00:01:00Z'),
          invalidatedReason: 'epoch_bump',
        },
      }),
    ).rejects.toThrow(/policy_decision_terminal_xor/);
  });

  it('rejects invalidated_reason on a row whose consumed_at is already set (two sequential UPDATEs)', async () => {
    const id = randomUUID();
    await prisma.policyDecision.create({ data: decisionData(id) });

    await prisma.policyDecision.update({
      where: { id },
      data: { consumedAt: new Date('2026-01-01T00:01:00Z') },
    });

    await expect(
      prisma.policyDecision.update({
        where: { id },
        data: { invalidatedReason: 'epoch_bump' },
      }),
    ).rejects.toThrow(/policy_decision_terminal_xor/);
  });

  it('rejects consumed_at on a row whose invalidated_reason is already set (two sequential UPDATEs, the other order)', async () => {
    const id = randomUUID();
    await prisma.policyDecision.create({ data: decisionData(id) });

    await prisma.policyDecision.update({
      where: { id },
      data: { invalidatedReason: 'epoch_bump' },
    });

    await expect(
      prisma.policyDecision.update({
        where: { id },
        data: { consumedAt: new Date('2026-01-01T00:01:00Z') },
      }),
    ).rejects.toThrow(/policy_decision_terminal_xor/);
  });

  it('still allows either column alone to transition from null', async () => {
    const consumedId = randomUUID();
    await prisma.policyDecision.create({ data: decisionData(consumedId) });
    await expect(
      prisma.policyDecision.update({
        where: { id: consumedId },
        data: { consumedAt: new Date('2026-01-01T00:01:00Z') },
      }),
    ).resolves.toMatchObject({ consumedAt: new Date('2026-01-01T00:01:00Z') });

    const invalidatedId = randomUUID();
    await prisma.policyDecision.create({ data: decisionData(invalidatedId) });
    await expect(
      prisma.policyDecision.update({
        where: { id: invalidatedId },
        data: { invalidatedReason: 'digest_mismatch' },
      }),
    ).resolves.toMatchObject({ invalidatedReason: 'digest_mismatch' });
  });
});
