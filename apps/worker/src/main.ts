import { createLogger, loadConfig, newCorrelationId, withCorrelation } from '@healer/shared';
import { type DrainResult } from '@healer/events';
import { createWorker, deadLetterDepth, createQueue, type QueueClass } from '@healer/workflow';

/**
 * The worker process. Same code as the api, separate process (plan.md): a flood of jobs must
 * not make the HTTP surface unavailable, and the two scale on different axes.
 *
 * Every handler runs inside a correlation scope, so one investigation is one identifier
 * across logs, traces and model calls (FR-032) — and under its queue's declared wall-clock
 * budget, which `createWorker` applies with no way to opt out.
 */
const config = loadConfig();
const logger = createLogger({ level: config.LOG_LEVEL, serviceName: 'healer-worker' });

/** Classes this process consumes. The outbox drain is the one processor that exists today. */
const CONSUMED: readonly QueueClass[] = ['maintenance'];

export function start(): { close: () => Promise<void> } {
  const connection = { url: config.REDIS_URL };

  const workers = CONSUMED.map((queue) =>
    createWorker(queue, connection, async (job) => {
      const correlationId =
        typeof (job.data as { correlationId?: unknown })?.correlationId === 'string'
          ? (job.data as { correlationId: string }).correlationId
          : newCorrelationId();

      return withCorrelation(correlationId, async () => {
        logger.info({ queue, jobId: job.id, correlationId, name: job.name }, 'job started');
        // Handlers are registered by the features that own them; nothing is registered here,
        // because a processor in this file would be a processor outside its domain package.
        return undefined;
      });
    }),
  );

  for (const worker of workers) {
    // A dead letter is kept and observable (T015). Silence here is the failure mode where
    // a queue drains into nothing and the investigation simply never finishes.
    worker.on('failed', (job, error) => {
      logger.error({ queue: worker.name, jobId: job?.id, err: error.message }, 'job failed');
    });
  }

  return {
    close: async () => {
      await Promise.all(workers.map((w) => w.close()));
    },
  };
}

/** Exposed so an operator's "is anything stuck" question has one answer per queue. */
export async function deadLetters(queue: QueueClass, connection: { url: string }): Promise<number> {
  const q = createQueue(queue, connection);
  try {
    return await deadLetterDepth(q);
  } finally {
    await q.close();
  }
}

export type { DrainResult };

if (process.argv[1]?.endsWith('main.js')) {
  const handle = start();
  const stop = (): void => void handle.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  logger.info({ queues: CONSUMED }, 'worker started');
}
