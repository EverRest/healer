import {
  createLogger,
  loadConfig,
  newCorrelationId,
  TenantContext,
  withCorrelation,
} from '@healer/shared';
import { type DrainResult } from '@healer/events';
import {
  FANOUT_JOB,
  TENANT_SWEEPS,
  createWorker,
  deadLetterDepth,
  createQueue,
  fanOutTenantSweep,
  registerTenantSweeps,
  type QueueClass,
  type TenantSweepName,
} from '@healer/workflow';
import {
  markStaleIssues,
  processSignalJob,
  PrismaIssueRepository,
  PrismaNormalisationRulesetRepository,
  type SignalJobData,
} from '@healer/domain-issues';
import { applyEvidenceRetention, PrismaEvidenceRetentionRepository } from '@healer/domain-evidence';
import {
  PrismaApprovalLifecycleRepository,
  PrismaApprovalRequestRepository,
  PrismaAutonomyEpochRepository,
  PrismaBudgetRepository,
  PrismaPolicyDecisionRepository,
  expireDueApprovals,
  releaseAbandonedCharges,
  sweepRevokedApprovals,
} from '@healer/domain-policy';
import { createPrismaClient } from './infrastructure/prisma.js';
import { PrismaTenantEnumerator } from './infrastructure/prisma-tenant-enumerator.js';

/** Records one retention run works through. The rest wait for the next run — oldest expiry first —
 *  rather than one pass outliving the `maintenance` queue's wall-clock budget. */
const RETENTION_BATCH = 500;

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
const CONSUMED: readonly QueueClass[] = ['maintenance', 'ingestion', 'scheduling'];

/** What a log line may say about a failure: names and messages only. Redaction is by field path,
 *  so a stack or a Prisma error object (which can embed query arguments) is not logged whole; an
 *  `AggregateError`'s per-item causes are kept, since the expiry tick reports through them. */
function describe(error: unknown): { err: string; causes?: string[] } {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (!(error instanceof AggregateError)) return { err: message };
  return {
    err: message,
    causes: error.errors.map((e) => (e instanceof Error ? e.name : typeof e)),
  };
}

export function start(): { ready: Promise<void>; close: () => Promise<void> } {
  const config = loadConfig();
  const logger = createLogger({ level: config.LOG_LEVEL, serviceName: 'healer-worker' });
  const connection = { url: config.REDIS_URL };
  const prisma = createPrismaClient(config.DATABASE_URL);
  const rulesetRepo = new PrismaNormalisationRulesetRepository(prisma);
  const issueRepo = new PrismaIssueRepository(prisma);
  const retentionRepo = new PrismaEvidenceRetentionRepository(prisma);
  const approvalRepos = {
    approvals: new PrismaApprovalLifecycleRepository(prisma),
    decisions: new PrismaPolicyDecisionRepository(prisma),
  };
  const tenants = new PrismaTenantEnumerator(prisma);
  const revocationRepos = {
    approvals: new PrismaApprovalRequestRepository(prisma),
    autonomyEpochs: new PrismaAutonomyEpochRepository(prisma),
  };
  const budgetRepo = new PrismaBudgetRepository(prisma, { log: logger });
  // One body per entry of `TENANT_SWEEPS`: a sweep with no body here fails to compile.
  const sweepBodies: Record<TenantSweepName, (context: TenantContext) => Promise<object>> = {
    'approval-expiry': async (context) => {
      const { expired, skipped } = await expireDueApprovals(approvalRepos, context);
      return { expired: expired.length, skipped };
    },
    'revoked-approvals-sweep': async (context) => {
      const { revoked, skipped } = await sweepRevokedApprovals(revocationRepos, context);
      return { revoked: revoked.length, skipped };
    },
    'abandoned-charges-release': async (context) => ({
      released: await releaseAbandonedCharges(budgetRepo, context, { now: new Date() }),
    }),
    // 001 T051, R-11.
    'staleness-sweep': async (context) => {
      const { marked, skipped } = await markStaleIssues(issueRepo, context, new Date());
      // A sweep that skips *everything* it found is what a broken race guard looks like — a green
      // job that marked nothing — so it is logged at warn, not folded into the return value alone.
      if (skipped > 0 && marked.length === 0) {
        logger.warn({ tenantId: context.tenantId, skipped }, 'staleness sweep skipped everything');
      }
      return { marked: marked.length, skipped };
    },
    // 001 T052, R-04, FR-009.
    'evidence-retention': async (context) =>
      applyEvidenceRetention(retentionRepo, context, new Date(), RETENTION_BATCH),
  };
  // One producer handle per consumed queue: the scheduler registers on it and the fan-out adds to it.
  const queues = new Map(CONSUMED.map((q) => [q, createQueue(q, connection)] as const));

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
        // C-90 / ADR 0018: the scheduler fires the fan-out; the fan-out enqueues one job per
        // tenant and returns — it never runs a sweep and never waits.
        if (job.name === FANOUT_JOB) {
          const result = await fanOutTenantSweep(tenants, queues.get(queue)!, {
            timestamp: job.timestamp,
            data: job.data as { sweep: string },
          });
          // Zero tenants is what a wrong database or an all-suspended fleet looks like: green job,
          // nothing swept — so it is a warning, not a summary line.
          const log = result.enqueued === 0 ? logger.warn : logger.info;
          log.call(logger, { queue, jobId: job.id, correlationId, ...result }, 'tenant fan-out');
          return result;
        }
        if (Object.hasOwn(TENANT_SWEEPS, job.name)) {
          const name = job.name as TenantSweepName;
          // The queue is declared once, in `TENANT_SWEEPS`; a job arriving anywhere else is a
          // mis-registration, and a green no-op there is exactly the gap C-90 closes.
          if (TENANT_SWEEPS[name].queue !== queue) {
            throw new Error(`tenant sweep ${name} arrived on ${queue}, not its declared queue`);
          }
          const { tenantId } = job.data as { tenantId: string };
          const result = await sweepBodies[name](TenantContext.forTrustedInternalUse(tenantId));
          logger.info(
            { queue, jobId: job.id, correlationId, tenantId, ...result },
            `${name} finished`,
          );
          return result;
        }
        return undefined;
      });
    }),
  );

  for (const worker of workers) {
    // A dead letter is kept and observable (T015). Silence here is the failure mode where
    // a queue drains into nothing and the investigation simply never finishes.
    worker.on('failed', (job, error) => {
      // The error itself, not its message: an AggregateError's per-item causes live in `.errors`.
      logger.error({ queue: worker.name, jobId: job?.id, ...describe(error) }, 'job failed');
    });
    // BullMQ reports a failure to schedule the *next* iteration here and nowhere else; without a
    // listener the schedule stops with a bare console line.
    worker.on('error', (error) => {
      logger.error({ queue: worker.name, ...describe(error) }, 'worker error');
    });
  }

  // A worker that failed to register its schedule would run fine and sweep nothing — the very gap
  // C-90 closes — so the entry point below exits on a rejection instead of carrying on.
  const unconsumed = Object.values(TENANT_SWEEPS).filter((s) => !CONSUMED.includes(s.queue));
  const ready = Promise.all(
    [...queues].map(([queue, producer]) => registerTenantSweeps(producer, queue)),
  ).then(() => {
    if (unconsumed.length > 0) {
      throw new Error('a tenant sweep is declared on a queue this worker does not consume');
    }
    logger.info({ sweeps: Object.keys(TENANT_SWEEPS) }, 'tenant sweeps registered');
  });

  return {
    ready,
    close: async () => {
      await Promise.all(workers.map((w) => w.close()));
      await Promise.all([...queues.values()].map((q) => q.close()));
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
  let stopping = false;
  handle.ready.catch((error: unknown) => {
    if (stopping) return; // closing the queues rejects a pending registration: not a failure
    createLogger({ level: loadConfig().LOG_LEVEL, serviceName: 'healer-worker' }).error(
      describe(error),
      'tenant sweep registration failed',
    );
    process.exit(1);
  });
  const stop = (): void => {
    stopping = true;
    void handle.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  createLogger({ level: loadConfig().LOG_LEVEL, serviceName: 'healer-worker' }).info(
    { queues: CONSUMED },
    'worker started',
  );
}
