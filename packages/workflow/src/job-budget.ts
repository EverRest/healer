/**
 * Runtime wall-clock budget per job (012 T054, FR-027, R-02, quickstart 7).
 *
 * A job-owned state declares `jobBudgetMs` (machine.ts); this is what enforces it at runtime.
 * Exceeding the budget fails the job and is recorded as a `workflow_transition` with cause
 * `timeout` — never a silent late success. "Raises an alert" is a structured error-level log
 * today: this repository has no dedicated alerting sink yet, and a log line at `error` level
 * through the shared, correlated logger is what a real alerting pipeline (Grafana/OTel, per
 * research R-17) is built to page on — not a second, bespoke notification path.
 */
export class JobBudgetExceededError extends Error {
  constructor(readonly budgetMs: number) {
    super(`job exceeded its ${budgetMs}ms wall-clock budget (FR-027)`);
    this.name = 'JobBudgetExceededError';
  }
}

/**
 * Races `fn` against `budgetMs`. `fn` receives an `AbortSignal` that fires on breach — JS cannot
 * force-preempt a running promise, so a slow `fn` that ignores the signal keeps running in the
 * background even though this function has already rejected; passing the signal through to
 * whatever `fn` awaits (fetch, a child process, a poll loop) is what turns "abandoned" into
 * "actually stopped," so a late side effect from the abandoned work is never mistaken for the
 * job's real, timely result (FR-027).
 */
export async function runWithBudget<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  budgetMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new JobBudgetExceededError(budgetMs);
      controller.abort(error);
      reject(error);
    }, budgetMs);
  });
  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Runs `fn` under its budget; on breach, logs the alert-equivalent error and rethrows so the
 * caller's own error handling (recording the `timeout` transition via `step()`) still runs.
 * Kept separate from `step()` itself: this module knows about wall-clock and logging, not about
 * the state machine's transition shape.
 */
export interface AlertLogger {
  /** Matches pino's `Logger.error` shape structurally — no dependency on pino's own type. */
  error(obj: Record<string, unknown>, msg: string): void;
}

export async function runJobWithBudget<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  budgetMs: number,
  context: { runId: string; state: string },
  logger: AlertLogger,
): Promise<T> {
  try {
    return await runWithBudget(fn, budgetMs);
  } catch (error) {
    if (error instanceof JobBudgetExceededError) {
      logger.error(
        { runId: context.runId, state: context.state, budgetMs },
        'job exceeded its wall-clock budget (FR-027)',
      );
    }
    throw error;
  }
}
