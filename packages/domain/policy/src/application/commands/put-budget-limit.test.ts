import { describe, expect, it } from 'vitest';
import { TenantContext, type TenantScoped } from '@healer/shared';
import { BUDGET_BOUNDS, BudgetBoundExceededError } from '../../domain/budget-bounds.js';
import type {
  BudgetLimit,
  BudgetLimitRepository,
  PutBudgetLimit,
} from '../../domain/budget-repository.js';
import { PUT_BUDGET_AUDIT_ACTION, putBudgetLimit } from './put-budget-limit.js';

// T057 + T088: budget configuration is audited (FR-020) and cannot cross a product bound
// (FR-021) — refused here with a typed error before any write; the migration's CHECKs are the
// second mechanism for a write that goes around this command.

const CONTEXT = TenantContext.forTrustedInternalUse('00000000-0000-0000-8000-0000000000b1');

class FakeLimits implements BudgetLimitRepository {
  writes: TenantScoped<PutBudgetLimit>[] = [];
  constructor(private readonly before: BudgetLimit | null = null) {}
  async list(): Promise<readonly BudgetLimit[]> {
    return this.before ? [this.before] : [];
  }
  async put(where: TenantScoped<PutBudgetLimit>) {
    this.writes.push(where);
    where.auditEntryFor(this.before, 'limit-1');
    return { before: this.before };
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
  it('writes the limit with thresholds normalised, recording who changed it', async () => {
    const repo = new FakeLimits();
    await putBudgetLimit(repo, CONTEXT, { ...valid, updatedBy: 'pavlo' });
    expect(repo.writes[0]).toMatchObject({
      scopeType: 'tenant',
      period: 'day',
      spendLimit: 10,
      softThresholdPcts: [50, 75],
      updatedBy: 'pavlo',
    });
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

  it('audits the change naming actor, before and after (quickstart 37)', async () => {
    const before: BudgetLimit = {
      scopeType: 'tenant',
      period: 'day',
      spendLimit: 4,
      timeLimitMs: 500,
      softThresholdPcts: [50],
      escalationAttemptCap: 1,
      updatedBy: 'someone',
    };
    const repo = new FakeLimits(before);
    let entry: ReturnType<PutBudgetLimit['auditEntryFor']> | undefined;
    const spy = {
      ...repo,
      list: repo.list.bind(repo),
      async put(where: TenantScoped<PutBudgetLimit>) {
        entry = where.auditEntryFor(before, 'limit-1');
        return { before };
      },
    };
    await putBudgetLimit(spy, CONTEXT, { ...valid, updatedBy: 'pavlo' });
    expect(entry).toMatchObject({
      actorType: 'human',
      actorRef: 'pavlo',
      action: PUT_BUDGET_AUDIT_ACTION,
      targetType: 'budget_limit',
      outcome: 'ok',
    });
    expect(entry?.reason).toContain('spendLimit 4 -> 10');
    expect(entry?.reason).toContain('escalationAttemptCap 1 -> 2');
  });
});
