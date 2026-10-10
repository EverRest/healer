import type { Queue } from 'bullmq';
import type { QueueClass } from '../queues/index.js';

/**
 * Per-tenant sweeps on a clock (C-90, ADR 0018). A BullMQ job scheduler fires a fan-out job; the
 * fan-out enqueues one job per active tenant; the sweep body runs per tenant. Nothing here waits
 * (ADR 0003) and nothing here runs a sweep.
 */

/** The one authority for which tenant sweeps exist. A job name here is also the name of the
 *  per-tenant job the worker routes to the sweep's body. */
export const TENANT_SWEEPS = {
  'approval-expiry': { queue: 'scheduling', everyMs: 60_000 },
} as const satisfies Record<string, { queue: QueueClass; everyMs: number }>;

export type TenantSweepName = keyof typeof TENANT_SWEEPS;

export const FANOUT_JOB = 'tenant-sweep-fanout';

/** Where tenant ids come from: a control-plane read, never a request (ADR 0018 §4). */
export interface TenantEnumerator {
  activeTenantIds(): Promise<readonly string[]>;
}

export interface FanOutJob {
  /** Stable across BullMQ retries of the same job — it is what makes a retry dedupe. */
  readonly timestamp: number;
  readonly data: { readonly sweep: string };
}

/** Idempotent: the scheduler id is the sweep name, so every boot upserts the same scheduler. */
export async function registerTenantSweeps(
  queue: Pick<Queue, 'upsertJobScheduler' | 'getJobSchedulers' | 'removeJobScheduler'>,
  on: QueueClass,
): Promise<void> {
  // The closed list stays the only authority: a scheduler left in Redis by a renamed or removed
  // sweep would otherwise fire a fan-out that fails forever.
  for (const { key } of await queue.getJobSchedulers()) {
    const current =
      Object.hasOwn(TENANT_SWEEPS, key) && TENANT_SWEEPS[key as TenantSweepName].queue === on;
    if (key && !current) await queue.removeJobScheduler(key);
  }
  for (const [sweep, settings] of Object.entries(TENANT_SWEEPS)) {
    if (settings.queue !== on) continue;
    await queue.upsertJobScheduler(
      sweep,
      { every: settings.everyMs },
      { name: FANOUT_JOB, data: { sweep } },
    );
  }
}

export async function fanOutTenantSweep(
  enumerator: TenantEnumerator,
  queue: Pick<Queue, 'add'>,
  job: FanOutJob,
): Promise<{ enqueued: number }> {
  const sweep = job.data.sweep;
  if (!Object.hasOwn(TENANT_SWEEPS, sweep)) throw new Error(`unknown tenant sweep: ${sweep}`);
  const tenantIds = await enumerator.activeTenantIds();
  for (const tenantId of tenantIds) {
    // `jobId` dedupes a retried fan-out; a `:` is not allowed in a custom BullMQ id.
    await queue.add(sweep, { tenantId }, { jobId: `${sweep}__${tenantId}__${job.timestamp}` });
  }
  return { enqueued: tenantIds.length };
}
