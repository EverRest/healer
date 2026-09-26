import { describe, expect, it, vi } from 'vitest';
import { QUEUE_CLASSES, WallClockExceededError, jobOptionsFor, withWallClock } from './index.js';

describe('queue classes', () => {
  it('declares a wall-clock budget for every class — there is no unbounded queue', () => {
    for (const [name, settings] of Object.entries(QUEUE_CLASSES)) {
      expect(settings.wallClockMs, name).toBeGreaterThan(0);
      expect(settings.concurrency, name).toBeGreaterThan(0);
    }
  });

  it('keeps dead letters, because a failure that deletes itself is never investigated', () => {
    expect(jobOptionsFor('reasoning').removeOnFail).toBe(false);
    expect(jobOptionsFor('reasoning').backoff.type).toBe('exponential');
  });

  it('gives production actions the narrowest concurrency and no retry', () => {
    expect(QUEUE_CLASSES.remediation.attempts).toBe(1);
    expect(QUEUE_CLASSES.remediation.concurrency).toBeLessThan(QUEUE_CLASSES.ingestion.concurrency);
  });
});

describe('wall-clock budget', () => {
  it('returns the processor result inside budget', async () => {
    await expect(withWallClock('scheduling', async () => 'done')).resolves.toBe('done');
  });

  it('fails loudly when a processor overruns instead of succeeding late', async () => {
    vi.useFakeTimers();
    try {
      const pending = withWallClock('scheduling', () => new Promise(() => {}));
      const assertion = expect(pending).rejects.toBeInstanceOf(WallClockExceededError);
      await vi.advanceTimersByTimeAsync(QUEUE_CLASSES.scheduling.wallClockMs + 1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
