import { describe, expect, it, vi } from 'vitest';
import { JobBudgetExceededError, runJobWithBudget, runWithBudget } from './job-budget.js';

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

describe('runWithBudget (012 T054, FR-027, quickstart 7)', () => {
  it('returns the result when the job finishes within budget', async () => {
    await expect(runWithBudget(() => delay(5, 'done'), 200)).resolves.toBe('done');
  });

  it('rejects with JobBudgetExceededError when the job outruns its budget — never a silent late success', async () => {
    await expect(runWithBudget(() => delay(200, 'too late'), 10)).rejects.toBeInstanceOf(
      JobBudgetExceededError,
    );
  });

  it('aborts the signal passed to fn on breach, so a cooperative fn actually stops instead of running unobserved', async () => {
    let observedAborted = false;
    const fn = (signal: AbortSignal) =>
      new Promise<string>((resolve) => {
        signal.addEventListener('abort', () => {
          observedAborted = true;
        });
        setTimeout(() => resolve('too late'), 200);
      });
    await expect(runWithBudget(fn, 10)).rejects.toBeInstanceOf(JobBudgetExceededError);
    expect(observedAborted).toBe(true);
  });
});

describe('runJobWithBudget: logs the alert-equivalent error on breach (012 T054)', () => {
  it('logs at error level and rethrows on a budget breach', async () => {
    const logger = { error: vi.fn() };
    await expect(
      runJobWithBudget(() => delay(200, 'x'), 10, { runId: 'r1', state: 's1' }, logger),
    ).rejects.toBeInstanceOf(JobBudgetExceededError);
    expect(logger.error).toHaveBeenCalledWith(
      { runId: 'r1', state: 's1', budgetMs: 10 },
      expect.stringContaining('wall-clock budget'),
    );
  });

  it('never logs when the job completes in time', async () => {
    const logger = { error: vi.fn() };
    await runJobWithBudget(() => delay(5, 'x'), 200, { runId: 'r1', state: 's1' }, logger);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('propagates a non-timeout error from the job without logging it as a budget breach', async () => {
    const logger = { error: vi.fn() };
    await expect(
      runJobWithBudget(
        () => Promise.reject(new Error('boom')),
        200,
        { runId: 'r1', state: 's1' },
        logger,
      ),
    ).rejects.toThrow('boom');
    expect(logger.error).not.toHaveBeenCalled();
  });
});
