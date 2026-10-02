import { scope, type TenantContext } from '@healer/shared';
import { scopeStanding } from '../../domain/budget-figures.js';
import type {
  BudgetRepository,
  MarkDegradationResult,
  ResolvedBudget,
} from '../../domain/budget-repository.js';
import { entryForStep, stepsToMark } from '../../domain/degradation.js';

export interface MarkDegradationCommand {
  readonly budget: ResolvedBudget;
  /** The issue the evidence attaches to — evidence is per issue (001). Absent for a dry-run-shaped
   *  evaluation with no issue: nothing is recorded, rather than inventing an issue to hold it. */
  readonly issueId?: string;
  readonly asOf: Date;
}

/**
 * `MarkDegradation` (T064, FR-012, R-12). For every scope whose consumption has crossed a soft
 * threshold, record each step from 1 to where it now stands — in order — as a `budget_degradation`
 * evidence record naming the entry applied from the declared order, the consumed and limit
 * figures and the pinned period key. The evidence record is the deliverable; the mark row is only
 * the idempotency key, so calling this on every evaluation is safe: a step already recorded
 * changes nothing (the repository's insert-or-skip), and a step a crash left unrecorded is
 * recorded by the next evaluation, because the step is derived from consumption, not remembered.
 */
export async function markDegradation(
  repo: Pick<BudgetRepository, 'markDegradation'>,
  context: TenantContext,
  command: MarkDegradationCommand,
): Promise<readonly MarkDegradationResult[]> {
  if (command.issueId === undefined) return [];
  const results: MarkDegradationResult[] = [];
  for (const figures of command.budget.scopes) {
    const standing = scopeStanding(figures);
    const thresholdCount = figures.softThresholdPcts.length;
    const steps = stepsToMark({
      crossed: standing.crossed,
      exhausted: standing.exhausted,
      thresholdCount,
    });
    for (const step of steps) {
      results.push(
        await repo.markDegradation(
          scope(context, {
            scopeType: figures.scopeType,
            scopeId: figures.scopeId,
            periodKey: figures.periodKey,
            step,
            entryApplied: entryForStep(command.budget.degradationOrder, step, thresholdCount),
            consumed: standing.consumed,
            limit: standing.limit,
            dimension: standing.dimension,
            issueId: command.issueId,
            observedAt: command.asOf,
          }),
        ),
      );
    }
  }
  return results;
}
