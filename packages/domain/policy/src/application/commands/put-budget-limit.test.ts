import { describe, expect, it } from 'vitest';
import { TenantContext, type TenantScoped } from '@healer/shared';
import {
  BUDGET_BOUNDS,
  BudgetBoundExceededError,
  BudgetThresholdsInvalidError,
} from '../../domain/budget-bounds.js';
import type {
  BudgetLimit,
  BudgetLimitRepository,
  PutBudgetLimit,
} from '../../domain/budget-repository.js';
import { PUT_BUDGET_AUDIT_ACTION, putBudgetLimit } from './put-budget-limit.js';

// T057 + T088: budget configuration is audited (FR-020) and cannot cross a product bound
// (FR-021) — refused here with a typed error before any write; the migration's CHECKs are the
// second mechanism for a write that goes around this command. The merge of a *partial* write over
// the limit in force happens inside the repository's transaction (e2e: budgets.e2e.test.ts).

const CONTEXT = TenantContext.forTrustedInternalUse('00000000-0000-0000-8000-0000000000b1');

const inForce: BudgetLimit = {
  scopeType: 'tenant',
  period: 'day',
  spendLimit: 4,
  timeLimitMs: 500,
  softThresholdPcts: [50],
  escalationAttemptCap: 1,
  updatedBy: 'in force',
};

class FakeLimits implements BudgetLimitRepository {
  writes: TenantScoped<PutBudgetLimit>[] = [];
  async list(): Promise<readonly BudgetLimit[]> {
    return [];
  }
  async put(where: TenantScoped<PutBudgetLimit>) {
    this.writes.push(where);
    return { before: inForce };
  }
}

const valid = {
  scopeType: 'tenant' as const,
  period: 'day' as const,
  spendLimit: 10,
  timeLimitMs: 1000,
  softThresholdPcts: [75, 50, 50],
  escalationAttemptCap: 2,
};

describe('putBudgetLimit', () => {
  it('passes the caller fields through, recording who changed it', async () => {
    const repo = new FakeLimits();
    await putBudgetLimit(repo, CONTEXT, { ...valid, updatedBy: 'pavlo' });
    expect(repo.writes[0]).toMatchObject({
      scopeType: 'tenant',
      period: 'day',
      spendLimit: 10,
      softThresholdPcts: [75, 50, 50],
      updatedBy: 'pavlo',
    });
  });

  it('a partial write sends only what was given — the repository merges over the limit in force', async () => {
    const repo = new FakeLimits();
    await putBudgetLimit(repo, CONTEXT, {
      scopeType: 'tenant',
      period: 'day',
      escalationAttemptCap: 1,
      updatedBy: 'pavlo',
    });
    expect(repo.writes[0]).toMatchObject({ escalationAttemptCap: 1 });
    expect(repo.writes[0]).not.toHaveProperty('spendLimit');
    expect(repo.writes[0]).not.toHaveProperty('softThresholdPcts');
  });

  it('refuses a spend limit above the product bound, before anything is written', async () => {
    const repo = new FakeLimits();
    await expect(
      putBudgetLimit(repo, CONTEXT, {
        ...valid,
        spendLimit: BUDGET_BOUNDS.maxSpendLimit.day + 1,
        updatedBy: 'pavlo',
      }),
    ).rejects.toThrow(BudgetBoundExceededError);
    expect(repo.writes).toEqual([]);
  });

  it('refuses an escalation attempt cap above the product bound', async () => {
    const repo = new FakeLimits();
    await expect(
      putBudgetLimit(repo, CONTEXT, {
        ...valid,
        escalationAttemptCap: BUDGET_BOUNDS.maxEscalationAttemptCap + 1,
        updatedBy: 'pavlo',
      }),
    ).rejects.toThrow(BudgetBoundExceededError);
    expect(repo.writes).toEqual([]);
  });

  it.each([[[0]], [[150]], [[10, 20, 30, 40, 50, 60]]])(
    'refuses soft thresholds %j instead of silently dropping them',
    async (softThresholdPcts) => {
      const repo = new FakeLimits();
      await expect(
        putBudgetLimit(repo, CONTEXT, { ...valid, softThresholdPcts, updatedBy: 'pavlo' }),
      ).rejects.toThrow(BudgetThresholdsInvalidError);
      expect(repo.writes).toEqual([]);
    },
  );

  it('refuses a scope/period pairing the product has no budget for (issue x day)', async () => {
    const repo = new FakeLimits();
    await expect(
      putBudgetLimit(repo, CONTEXT, {
        ...valid,
        scopeType: 'issue',
        period: 'day',
        updatedBy: 'pavlo',
      }),
    ).rejects.toThrow(/period/);
    expect(repo.writes).toEqual([]);
  });

  it('audits the change, naming actor, before and after (quickstart 37)', async () => {
    const repo = new FakeLimits();
    await putBudgetLimit(repo, CONTEXT, { ...valid, updatedBy: 'pavlo' });
    const after: BudgetLimit = { ...inForce, spendLimit: 10, escalationAttemptCap: 2 };
    const entry = repo.writes[0]?.auditEntryFor(inForce, after, 'limit-1');
    expect(entry).toMatchObject({
      actorType: 'human',
      actorRef: 'pavlo',
      action: PUT_BUDGET_AUDIT_ACTION,
      targetType: 'budget_limit',
      targetId: 'limit-1',
      outcome: 'ok',
    });
    expect(entry?.reason).toContain('spendLimit 4 -> 10');
    expect(entry?.reason).toContain('escalationAttemptCap 1 -> 2');
  });
});
