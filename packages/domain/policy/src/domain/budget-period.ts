import type { BudgetPeriod } from './budget-bounds.js';

/**
 * The budget window key for an instant (T062, FR-011): UTC calendar day `YYYY-MM-DD`, UTC calendar
 * month `YYYY-MM`, or the constant `issue` for the per-issue period (which has no calendar).
 *
 * Pure: the instant is an input, so a decision replays a year later. **Which** instant is passed
 * is what pins a workflow to the window in force at request time — the infrastructure keys every
 * charge by the run's *start* (`workflow_run.started_at`), never by when a later step happens to
 * run, so a run that straddles midnight cannot gain a fresh budget.
 */
export function periodKeyFor(period: BudgetPeriod, instant: Date): string {
  if (period === 'issue') return 'issue';
  const iso = instant.toISOString(); // always UTC
  return period === 'day' ? iso.slice(0, 10) : iso.slice(0, 7);
}

/** The half-open UTC window `[start, end)` that `periodKeyFor` names for this instant; `null` for
 *  the per-issue period, which has none. The aggregate selects on this window. */
export function periodWindow(
  period: BudgetPeriod,
  instant: Date,
): { readonly start: Date; readonly end: Date } | null {
  if (period === 'issue') return null;
  const y = instant.getUTCFullYear();
  const m = instant.getUTCMonth();
  if (period === 'month')
    return { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1)) };
  const d = instant.getUTCDate();
  return { start: new Date(Date.UTC(y, m, d)), end: new Date(Date.UTC(y, m, d + 1)) };
}
