import { randomUUID } from 'node:crypto';
import { HealerError, scope, type TenantContext } from '@healer/shared';
import { assertWithinBudgetBounds, type BudgetPeriod } from '../../domain/budget-bounds.js';
import { normaliseThresholds } from '../../domain/budget-limits.js';
import type { BudgetLimit, BudgetLimitRepository } from '../../domain/budget-repository.js';

/** The audit `action` a budget write records — registered in `SEED_POLICY_ACTIONS` with
 *  `mutating: false` (a configuration change, never itself a decision the ceiling gates), the same
 *  treatment `policy.grant_autonomy` gets. */
export const PUT_BUDGET_AUDIT_ACTION = 'policy.update_budget';

export interface PutBudgetLimitCommand {
  readonly scopeType: 'issue' | 'tenant';
  readonly period: BudgetPeriod;
  readonly spendLimit: number;
  readonly timeLimitMs: number;
  readonly softThresholdPcts: readonly number[];
  readonly escalationAttemptCap: number;
  readonly updatedBy: string;
}

/** `scopeType = issue` has exactly the `issue` period, `tenant` has `day` and `month` — the table
 *  CHECKs the same pairing. */
export class BudgetScopePeriodError extends HealerError {
  constructor(scopeType: string, period: string) {
    super('VALIDATION', `period "${period}" is not a budget period for scope "${scopeType}"`);
    this.name = 'BudgetScopePeriodError';
  }
}

function describeChange(before: BudgetLimit | null, after: PutBudgetLimitCommand): string {
  const fields = ['spendLimit', 'timeLimitMs', 'escalationAttemptCap'] as const;
  const changes = fields.map((f) => `${f} ${before ? before[f] : 'unset'} -> ${after[f]}`);
  const pcts = (p: readonly number[] | undefined) => (p ? `[${p.join(',')}]` : 'unset');
  changes.push(
    `softThresholdPcts ${pcts(before?.softThresholdPcts)} -> ${pcts(after.softThresholdPcts)}`,
  );
  return `${after.scopeType}/${after.period}: ${changes.join('; ')}`;
}

/**
 * `PUT /budgets` (T057, T088; FR-011, FR-020, FR-021). Refuses a write above a product bound or a
 * scope/period pairing the product has no budget for, **before** the write; the change and its
 * audit entry (naming actor, before and after) commit in one transaction.
 */
export async function putBudgetLimit(
  repo: BudgetLimitRepository,
  context: TenantContext,
  command: PutBudgetLimitCommand,
): Promise<void> {
  const validPeriod =
    command.scopeType === 'issue' ? command.period === 'issue' : command.period !== 'issue';
  if (!validPeriod) throw new BudgetScopePeriodError(command.scopeType, command.period);
  assertWithinBudgetBounds(command);

  const normalised = {
    ...command,
    softThresholdPcts: normaliseThresholds(command.softThresholdPcts),
  };
  await repo.put(
    scope(context, {
      ...normalised,
      auditEntryFor: (before: BudgetLimit | null, limitId: string) =>
        scope(context, {
          id: randomUUID(),
          actorType: 'human' as const,
          actorRef: command.updatedBy,
          action: PUT_BUDGET_AUDIT_ACTION,
          targetType: 'budget_limit',
          targetId: limitId,
          reason: describeChange(before, normalised),
          evidenceIds: [],
          outcome: 'ok',
        }),
    }),
  );
}
