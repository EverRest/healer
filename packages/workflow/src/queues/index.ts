/**
 * Queue classes (012 T015). One queue per workload class, not one queue for everything:
 * a flood of ingestion must not delay a verification tick, and a model-bound job must not
 * hold a slot a cheap job needs.
 *
 * `wallClockMs` is a **declared budget, not a hope** (R-02, FR-027). Exceeding it fails the
 * job and records a `timeout` transition. The other half of the rule — no sleeping, no
 * polling, no awaiting external completion inside a processor — is the lint rule of 012 T035.
 *
 * A new class is added to the constitution in the pull request that introduces it
 * (constitution, Governance).
 */
export const QUEUE_CLASSES = {
  /** Signal intake. High volume, cheap, must never block a provider (001 FR-019). */
  ingestion: { concurrency: 16, attempts: 5, wallClockMs: 30_000 },
  /** Evidence collection across the plane boundary (003). Bounded by the runner, not by us. */
  collection: { concurrency: 8, attempts: 3, wallClockMs: 120_000 },
  /** Model-bound work: classification, hypotheses, drafting (006, 009). */
  reasoning: { concurrency: 4, attempts: 2, wallClockMs: 300_000 },
  /** Sandbox work dispatched to the runner (007, 008). The runner enforces its own limits. */
  execution: { concurrency: 4, attempts: 2, wallClockMs: 120_000 },
  /** Production actions (010). Serialized per target by a lock, never by queue depth. */
  remediation: { concurrency: 2, attempts: 1, wallClockMs: 60_000 },
  /** Deadline ticks and callback resolution. Small, frequent, must never queue behind work. */
  scheduling: { concurrency: 8, attempts: 5, wallClockMs: 15_000 },
  /** Outbox drain, retention, staleness, reconciliation. */
  maintenance: { concurrency: 2, attempts: 3, wallClockMs: 600_000 },
} as const;

export type QueueClass = keyof typeof QUEUE_CLASSES;
export type QueueSettings = (typeof QUEUE_CLASSES)[QueueClass];

/** Retry with exponential backoff; a dead letter is kept and observable, never dropped. */
export function jobOptionsFor(queue: QueueClass): {
  attempts: number;
  backoff: { type: 'exponential'; delay: number };
  removeOnComplete: number;
  removeOnFail: false;
} {
  return {
    attempts: QUEUE_CLASSES[queue].attempts,
    backoff: { type: 'exponential', delay: 1_000 },
    removeOnComplete: 1_000,
    // Dead letters stay. A failure that deletes itself is a failure nobody investigates.
    removeOnFail: false,
  };
}

export class WallClockExceededError extends Error {
  constructor(
    readonly queue: QueueClass,
    readonly budgetMs: number,
    readonly elapsedMs: number,
  ) {
    super(`job on ${queue} exceeded its declared ${budgetMs}ms budget after ${elapsedMs}ms`);
    this.name = 'WallClockExceededError';
  }
}

/**
 * Runs a processor under its queue's declared budget. The static lint rule catches the
 * obvious waits; this catches the creative ones — and a breach is loud, because a job that
 * silently succeeds late is what eventually forces a Temporal migration (ADR 0003).
 */
export async function withWallClock<T>(
  queue: QueueClass,
  processor: () => Promise<T>,
  options: { now?: () => number } = {},
): Promise<T> {
  const clock = options.now ?? (() => Date.now());
  const budgetMs = QUEUE_CLASSES[queue].wallClockMs;
  const startedAt = clock();

  let timer: NodeJS.Timeout | undefined;
  const breach = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new WallClockExceededError(queue, budgetMs, clock() - startedAt)),
      budgetMs,
    );
    timer.unref?.();
  });

  try {
    return await Promise.race([processor(), breach]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
