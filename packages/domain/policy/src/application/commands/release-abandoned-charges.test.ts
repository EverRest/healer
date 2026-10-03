import { describe, expect, it } from 'vitest';
import { TenantContext, type TenantScoped } from '@healer/shared';
import { ABANDONED_CHARGE_TTL_MS } from '../../domain/budget-bounds.js';
import { releaseAbandonedCharges } from './release-abandoned-charges.js';

const CONTEXT = TenantContext.forTrustedInternalUse('00000000-0000-0000-8000-0000000000e1');

// T060 (review: silent-failure #1): an allowed AI step whose run never starts must not hold its
// declared maximum forever. The command only decides *which cutoff*; the repository finds the
// charges (e2e: budget-release.e2e.test.ts). Nothing schedules it — no production caller yet.
describe('releaseAbandonedCharges', () => {
  const run = async (opts: { now: Date; ttlMs?: number }) => {
    const cutoffs: Date[] = [];
    const released = await releaseAbandonedCharges(
      {
        releaseAbandonedCharges: async (where: TenantScoped<{ readonly olderThan: Date }>) => {
          cutoffs.push(where.olderThan);
          return 3;
        },
      },
      CONTEXT,
      opts,
    );
    return { released, cutoffs };
  };

  it('releases decisions older than the declared TTL before the given instant, and reports how many', async () => {
    const now = new Date('2026-10-02T12:00:00Z');
    const { released, cutoffs } = await run({ now });
    expect(released).toBe(3);
    expect(cutoffs[0]).toEqual(new Date(now.getTime() - ABANDONED_CHARGE_TTL_MS));
  });

  it('takes the instant as an input — it reads no clock', async () => {
    const a = await run({ now: new Date('2026-10-02T12:00:00Z') });
    const b = await run({ now: new Date('2026-10-02T13:00:00Z') });
    expect(b.cutoffs[0]!.getTime() - a.cutoffs[0]!.getTime()).toBe(3_600_000);
  });

  it('refuses a TTL shorter than the declared one: a step still allowed to run must keep its charge', async () => {
    await expect(run({ now: new Date(), ttlMs: ABANDONED_CHARGE_TTL_MS - 1 })).rejects.toThrow(
      /ttl/i,
    );
  });
});
