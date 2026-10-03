import { describe, expect, it } from 'vitest';
import { checkAutonomyEpoch, StaleAutonomyEpochError } from './check-autonomy-epoch.js';

describe('checkAutonomyEpoch (T044, R-07)', () => {
  it('passes when the recorded epoch still matches the current one', () => {
    expect(() => checkAutonomyEpoch({ id: 'approval-1', autonomyEpoch: 2n }, 2n)).not.toThrow();
  });

  it('refuses when the current epoch has moved past the recorded one', () => {
    expect(() => checkAutonomyEpoch({ id: 'approval-1', autonomyEpoch: 0n }, 1n)).toThrow(
      StaleAutonomyEpochError,
    );
  });

  it('StaleAutonomyEpochError is a HealerError with code STALE_AUTONOMY_EPOCH', () => {
    try {
      checkAutonomyEpoch({ id: 'approval-1', autonomyEpoch: 0n }, 1n);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: 'STALE_AUTONOMY_EPOCH', approvalId: 'approval-1' });
    }
  });
});
