import { describe, expect, it } from 'vitest';
import { fanOutTenantSweep } from './tenant-sweep.js';

describe('fanOutTenantSweep (T105)', () => {
  it('refuses a sweep that is not in the closed list', async () => {
    const queue = { add: async () => ({}) as never };
    await expect(
      fanOutTenantSweep({ activeTenantIds: async () => [] }, queue, {
        timestamp: 1,
        data: { sweep: 'not-a-sweep' },
      }),
    ).rejects.toThrow(/unknown tenant sweep/);
  });
});
