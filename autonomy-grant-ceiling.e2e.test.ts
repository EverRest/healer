import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, withPrivilegedWrite } from '@healer/prisma-client';
import { evaluate, type DecisionInput, type ResolvedRuleset } from '@healer/domain-policy';
import { buildDecisionInput } from './packages/domain/policy/src/domain/test-support/fixtures.js';
import { applySqlFile, startPostgres, type StartedPostgres } from './test/containers.js';
import { findOverCeilingGrants } from './scripts/checks/ceiling.mjs';

/**
 * 002 T035/T036 (FR-008, SC-004, R-05, C-18, quickstart 7, 9, 39). The DB trigger
 * (`policy_autonomy_grant_ceiling`, migration `20261003060000_autonomy_grant_ceiling`) is the
 * first of R-05's two independent mechanisms — "the constraint stops the row being written."
 * T036 proves the second still holds even when the first is bypassed via the one documented
 * escape hatch (`healer.privileged_write`): `evaluate()`'s own clamp (built in T012) refuses
 * regardless of what a hand-written row says.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-0000-000000000f31';

describe('autonomy_grant ceiling trigger (T035, T036)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    await prisma.policyAction.createMany({
      data: [
        {
          actionKey: 'change.open_pull_request',
          actionClass: 'code_change',
          mutating: true,
          owningSpec: '008',
          introducedAt: new Date('2026-01-01T00:00:00Z'),
        },
        {
          actionKey: 'deployment.rollback',
          actionClass: 'reversible_remediation',
          mutating: true,
          owningSpec: '010',
          introducedAt: new Date('2026-01-01T00:00:00Z'),
        },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  function grantData(
    overrides: Partial<Parameters<PrismaClient['autonomyGrant']['create']>[0]['data']> = {},
  ) {
    return {
      id: randomUUID(),
      tenantId: TENANT_ID,
      actionKey: 'change.open_pull_request',
      level: 2,
      grantedBy: 'pavlo',
      grantedAt: new Date('2026-01-01T00:00:00Z'),
      ...overrides,
    };
  }

  // Quickstart 7: grant L3 for change.open_pull_request (class code_change, ceiling L2) —
  // rejected at the database, even for a raw insert bypassing every application-layer check.
  it('rejects an INSERT above the action class ceiling', async () => {
    await expect(prisma.autonomyGrant.create({ data: grantData({ level: 3 }) })).rejects.toThrow(
      /exceeds ACTION_CEILING/,
    );
  });

  it('accepts an INSERT at or under the ceiling', async () => {
    await expect(
      prisma.autonomyGrant.create({ data: grantData({ level: 2 }) }),
    ).resolves.toMatchObject({ level: 2 });
  });

  // Quickstart 39 / C-18: reversible_remediation has no attested-undo data source in this
  // repository yet, so the trigger — like `grantAutonomy` — refuses any level for that class.
  it('rejects any level for reversible_remediation (no undo attestation source exists)', async () => {
    await expect(
      prisma.autonomyGrant.create({
        data: grantData({ actionKey: 'deployment.rollback', level: 0 }),
      }),
    ).rejects.toThrow(/exceeds ACTION_CEILING/);
  });

  it('rejects an UPDATE that raises a grant above its ceiling', async () => {
    const id = randomUUID();
    await prisma.autonomyGrant.create({ data: grantData({ id, level: 1 }) });
    await expect(
      prisma.autonomyGrant.update({ where: { id }, data: { level: 3 } }),
    ).rejects.toThrow(/exceeds ACTION_CEILING/);
  });

  // Quickstart 9: bypassing the API is not the same as bypassing the database outright — this
  // uses the one documented escape hatch, the same one production retention/migration code uses,
  // deliberately, to prove the *second* mechanism.
  it('a row written through the privileged-write bypass still cannot exceed the ceiling at evaluation time', async () => {
    const id = randomUUID();
    await withPrivilegedWrite(prisma, (tx) =>
      tx.autonomyGrant.create({ data: grantData({ id, level: 5 }) }),
    );

    const row = await prisma.autonomyGrant.findUniqueOrThrow({ where: { id } });
    expect(row.level).toBe(5);

    const input: DecisionInput = buildDecisionInput({ autonomy: { level: row.level } });
    const ruleset: ResolvedRuleset = {
      version: 1,
      rules: [
        {
          ruleKey: 'allow-at-any-level',
          predicates: [],
          outcome: 'allow',
          reasonCode: 'NO_ADOPTED_EXPECTATION',
        },
      ],
    };
    const { decision, trace } = evaluate(ruleset, input);
    expect(decision.outcome).toBe('deny');
    expect(decision.reasonCodes).toContain('CEILING_EXCEEDED');
    expect(trace.ceilingApplied).toBe(true);
  });

  it('the privileged-write bypass alone does not skip the trigger for a non-privileged session', async () => {
    // Sanity check that the fixture above genuinely exercised the bypass, not a coincidence:
    // the very next statement outside that transaction is refused normally.
    await expect(prisma.autonomyGrant.create({ data: grantData({ level: 5 }) })).rejects.toThrow(
      /exceeds ACTION_CEILING/,
    );
  });

  // check:ceiling (T038's continuous-reconciliation half): the DB trigger is the only normal way
  // an over-ceiling row could exist, so proving the check's query flags one needs the same
  // privileged-write bypass the trigger test above already uses.
  describe('check:ceiling — findOverCeilingGrants', () => {
    it('flags a grant above its ceiling, written via the privileged-write bypass', async () => {
      const id = randomUUID();
      await withPrivilegedWrite(prisma, (tx) =>
        tx.autonomyGrant.create({ data: grantData({ id, level: 5 }) }),
      );
      const violations = await findOverCeilingGrants(prisma);
      expect(violations.some((message) => message.includes(id))).toBe(true);
    });

    it('does not flag a grant at or under its ceiling', async () => {
      const id = randomUUID();
      await prisma.autonomyGrant.create({ data: grantData({ id, level: 2 }) });
      const violations = await findOverCeilingGrants(prisma);
      expect(violations.some((message) => message.includes(id))).toBe(false);
    });

    it('does not flag a revoked grant, even one above the ceiling', async () => {
      const id = randomUUID();
      await withPrivilegedWrite(prisma, (tx) =>
        tx.autonomyGrant.create({
          data: grantData({
            id,
            level: 5,
            revokedBy: 'pavlo',
            revokedAt: new Date('2026-01-02T00:00:00Z'),
          }),
        }),
      );
      const violations = await findOverCeilingGrants(prisma);
      expect(violations.some((message) => message.includes(id))).toBe(false);
    });
  });
});
