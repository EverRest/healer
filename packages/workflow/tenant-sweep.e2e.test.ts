import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Queue } from 'bullmq';
import { startRedis } from '../../test/containers.js';
import { createQueue } from './src/queues/bullmq.js';
import {
  FANOUT_JOB,
  TENANT_SWEEPS,
  fanOutTenantSweep,
  registerTenantSweeps,
  type TenantEnumerator,
} from './src/schedule/tenant-sweep.js';

/** C-90 / ADR 0018 against a real Redis: the guarantees here are BullMQ's `jobId` dedupe and
 *  scheduler upsert, which a fake would only restate. */
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';

describe('tenant sweeps on BullMQ (T105)', () => {
  let redis: Awaited<ReturnType<typeof startRedis>>;
  let queue: Queue;

  beforeAll(async () => {
    redis = await startRedis();
    queue = createQueue('scheduling', { url: redis.url });
  }, 120_000);

  afterAll(async () => {
    await queue?.close();
    await redis?.stop();
  });

  it('registering twice (two worker boots) leaves exactly one scheduler per sweep', async () => {
    await registerTenantSweeps(queue, 'scheduling');
    await registerTenantSweeps(queue, 'scheduling');
    const schedulers = await queue.getJobSchedulers();
    const expected = Object.values(TENANT_SWEEPS).filter((s) => s.queue === 'scheduling').length;
    expect(expected).toBeGreaterThan(0);
    expect(schedulers).toHaveLength(expected);
    expect(schedulers[0]!.name).toBe(FANOUT_JOB);
  });

  it('a scheduler whose sweep left the closed list is removed on the next boot', async () => {
    await queue.upsertJobScheduler(
      'renamed-away',
      { every: 60_000 },
      { name: FANOUT_JOB, data: { sweep: 'renamed-away' } },
    );
    await registerTenantSweeps(queue, 'scheduling');
    const ids = (await queue.getJobSchedulers()).map((s) => s.key);
    expect(ids).not.toContain('renamed-away');
    expect(ids).toContain('approval-expiry');
  });

  it('a fan-out that dies halfway and is retried leaves exactly one job per tenant', async () => {
    const enumerator: TenantEnumerator = { activeTenantIds: async () => [A, B, C] };
    let adds = 0;
    const crashing = {
      add: (...args: Parameters<Queue['add']>) => {
        adds += 1;
        if (adds === 2) throw new Error('worker killed');
        return queue.add(...args);
      },
    };
    const job = { timestamp: 1_700_000_000_000, data: { sweep: 'approval-expiry' } };

    await expect(fanOutTenantSweep(enumerator, crashing, job)).rejects.toThrow('worker killed');
    await fanOutTenantSweep(enumerator, queue, job); // BullMQ's retry: same job, same timestamp

    const jobs = (await queue.getJobs(['waiting', 'delayed'])).filter(
      (j) => j.name === 'approval-expiry',
    );
    expect(jobs.map((j) => (j.data as { tenantId: string }).tenantId).sort()).toEqual([A, B, C]);
    // each job names its own tenant and nothing else
    expect(jobs.every((j) => Object.keys(j.data as object).join() === 'tenantId')).toBe(true);
  });
});
