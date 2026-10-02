import { randomUUID } from 'node:crypto';
import { HealerError, scope, type TenantContext } from '@healer/shared';
import { assertWithinBudgetBounds, type BudgetPeriod } from '../../domain/budget-bounds.js';
import type { BudgetLimit, BudgetLimitRepository } from '../../domain/budget-repository.js';

/** The audit `action` a budget write records — registered in `SEED_POLICY_ACTIONS` with
 *  `mutating: false` (a configuration change, never itself a decision the ceiling gates), the same
 *  treatment `policy.grant_autonomy` gets. */
export const PUT_BUDGET_AUDIT_ACTION = 'policy.update_budget';

export interface PutBudgetLimitCommand {
  readonly scopeType: 'issue' | 'tenant';
  readonly period: BudgetPeriod;
  /** Every limit field is optional: an omitted one keeps what is in force (the stored row, else
   *  012's `tenant_budget`, else the product default), merged inside the repository's
   *  transaction — never reverted to a default by a partial write. */
  readonly spendLimit?: number;
  readonly timeLimitMs?: number;
  readonly softThresholdPcts?: readonly number[];
  readonly escalationAttemptCap?: number;
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

function describeChange(before: BudgetLimit, after: BudgetLimit): string {
  const fields = ['spendLimit', 'timeLimitMs', 'escalationAttemptCap'] as const;
  const changes = fields.map((f) => `${f} ${before[f]} -> ${after[f]}`);
  changes.push(
    `softThresholdPcts [${before.softThresholdPcts.join(',')}] -> [${after.softThresholdPcts.join(',')}]`,
  );
  return `${after.scopeType}/${after.period}: ${changes.join('; ')}`;
}

/**
 * `PUT /budgets` (T057, T088; FR-011, FR-020, FR-021). Refuses a write above a product bound, a
 * threshold that is out of range or too many, or a scope/period pairing the product has no budget
 * for, **before** the write — typed errors, never a silent drop and never a database error. The
 * repository then merges the fields over the limit in force and bounds the *merged* result; the
 * change and its audit entry (naming actor, before and after) commit in one transaction.
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

  await repo.put(
    scope(context, {
      ...command,
      auditEntryFor: (before: BudgetLimit, after: BudgetLimit, limitId: string) =>
        scope(context, {
          id: randomUUID(),
          actorType: 'human' as const,
          actorRef: command.updatedBy,
          action: PUT_BUDGET_AUDIT_ACTION,
          targetType: 'budget_limit',
          targetId: limitId,
          reason: describeChange(before, after),
          evidenceIds: [],
          outcome: 'ok',
        }),
    }),
  );
}
