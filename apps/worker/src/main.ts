import {
  createLogger,
  loadConfig,
  newCorrelationId,
  TenantContext,
  withCorrelation,
} from '@healer/shared';
import { type DrainResult } from '@healer/events';
import { createWorker, deadLetterDepth, createQueue, type QueueClass } from '@healer/workflow';
import {
  markStaleIssues,
  processSignalJob,
  PrismaIssueRepository,
  PrismaNormalisationRulesetRepository,
  type SignalJobData,
} from '@healer/domain-issues';
import { createPrismaClient } from './infrastructure/prisma.js';

/**
 * The worker process. Same code as the api, separate process (plan.md): a flood of jobs must
 * not make the HTTP surface unavailable, and the two scale on different axes.
 *
 * Every handler runs inside a correlation scope, so one investigation is one identifier
 * across logs, traces and model calls (FR-032) — and under its queue's declared wall-clock
 * budget, which `createWorker` applies with no way to opt out.
 *
 * `loadConfig()` is called inside `start()`, not at module load (001 T025 review): a test
 * booting a real Postgres/Redis on ephemeral ports sets `DATABASE_URL`/`REDIS_URL` only once it
 * knows them, after this module has already been imported — a module-level `loadConfig()` would
 * have read whatever was in the environment at import time instead.
 */

/** Classes this process consumes. `ingestion` is 001's own signal-processing queue (T025); the
 *  outbox drain is `maintenance`'s one processor. */
const CONSUMED: readonly QueueClass[] = ['maintenance', 'ingestion'];

export function start(): { close: () => Promise<void> } {
  const config = loadConfig();
  const logger = createLogger({ level: config.LOG_LEVEL, serviceName: 'healer-worker' });
  const connection = { url: config.REDIS_URL };
  const prisma = createPrismaClient(config.DATABASE_URL);
  const rulesetRepo = new PrismaNormalisationRulesetRepository(prisma);
  const issueRepo = new PrismaIssueRepository(prisma);

  const workers = CONSUMED.map((queue) =>
    createWorker(queue, connection, async (job) => {
      const correlationId =
        typeof (job.data as { correlationId?: unknown })?.correlationId === 'string'
          ? (job.data as { correlationId: string }).correlationId
          : newCorrelationId();

      return withCorrelation(correlationId, async () => {
        logger.info({ queue, jobId: job.id, correlationId, name: job.name }, 'job started');
        // Handlers are registered by the feature that owns them (001), not invented in this
        // generic dispatch loop — this is the one place a queue/job-name pair is routed to it.
        if (queue === 'ingestion' && job.name === 'signal') {
          const result = await processSignalJob(rulesetRepo, issueRepo, job.data as SignalJobData);
          // BullMQ JSON.stringifies whatever a handler returns to store as the job's
          // `returnvalue` (review finding, reproduced): the full `Issue` carries
          // `occurrenceCount: bigint`, which `JSON.stringify` throws on — silently turning a
          // *successful* ingest into a reported job failure, and into a retry that would double
          // -count the very occurrence it just recorded. Return a JSON-safe summary instead; the
          // domain result itself is for `ingestSignal`'s other, non-queue callers.
          return { issueId: result.issue.id, created: result.created };
        }
        // The staleness sweep (001 T051, R-11): one job per tenant, so no query in it is ever
        // cross-tenant. Nothing schedules these yet — see QUESTIONS.md "001 T051".
        if (queue === 'maintenance' && job.name === 'staleness-sweep') {
          const { tenantId } = job.data as { tenantId: string };
          const { marked, skipped } = await markStaleIssues(
            issueRepo,
            TenantContext.forTrustedInternalUse(tenantId),
            new Date(),
          );
          // Skips are expected to be rare. A sweep that skips *everything* it found is what a
          // broken race guard looks like — a green job that marked nothing — so it is logged
          // at warn where an operator can see it, not folded into the return value alone.
          const log = skipped > 0 && marked.length === 0 ? logger.warn : logger.info;
          log.call(
            logger,
            { queue, jobId: job.id, correlationId, tenantId, marked: marked.length, skipped },
            'staleness sweep finished',
          );
          return { marked: marked.length, skipped };
        }
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
      await prisma.$disconnect();
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
  createLogger({ level: loadConfig().LOG_LEVEL, serviceName: 'healer-worker' }).info(
    { queues: CONSUMED },
    'worker started',
  );
}
