import { describe, expect, it } from 'vitest';
import {
  ApprovalNotDueError,
  ApprovalWithoutDeadlineError,
  assertDue,
  assertRedeemable,
  assertRequestable,
  projectExpiry,
} from './approval-lifecycle.js';
import { ApprovalNotPendingError, type LockedApproval } from './approval-request-repository.js';
import {
  DecisionAlreadyConsumedError,
  DecisionNotAllowedError,
} from './policy-decision-repository.js';
import { StaleAutonomyEpochError } from './check-autonomy-epoch.js';

const T0 = new Date('2026-10-01T12:00:00Z');
const plus = (ms: number) => new Date(T0.getTime() + ms);

function locked(overrides: Partial<LockedApproval> = {}): LockedApproval {
  return { id: 'a1', state: 'pending', expiresAt: plus(60_000), autonomyEpoch: 3n, ...overrides };
}

describe('projectExpiry (T073, R-09: expires_at never later than the run deadline)', () => {
  it('uses the earlier of the requested expiry and the run deadline', () => {
    expect(projectExpiry(plus(10), plus(20))).toEqual(plus(10));
    expect(projectExpiry(plus(30), plus(20))).toEqual(plus(20));
  });
  it('falls back to whichever exists', () => {
    expect(projectExpiry(plus(10), undefined)).toEqual(plus(10));
    expect(projectExpiry(undefined, plus(20))).toEqual(plus(20));
  });
  it('refuses when neither exists: nothing would ever fire the expiry', () => {
    expect(() => projectExpiry(undefined, undefined)).toThrow(ApprovalWithoutDeadlineError);
  });
});

describe('assertRedeemable (T074, R-07, FR-016)', () => {
  it('passes for a pending, unlapsed request at the current epoch', () => {
    expect(() => assertRedeemable(locked(), 3n, T0)).not.toThrow();
  });
  it.each(['approved', 'rejected', 'expired', 'revoked'] as const)('refuses a %s request', (s) => {
    expect(() => assertRedeemable(locked({ state: s }), 3n, T0)).toThrow(ApprovalNotPendingError);
  });
  it('refuses a request past expires_at even when no tick has fired yet (SC-007)', () => {
    expect(() => assertRedeemable(locked(), 3n, plus(59_999))).not.toThrow();
    expect(() => assertRedeemable(locked(), 3n, plus(60_000))).toThrow(ApprovalNotPendingError);
  });
  it('refuses a stale epoch with STALE_AUTONOMY_EPOCH', () => {
    expect(() => assertRedeemable(locked(), 4n, T0)).toThrow(StaleAutonomyEpochError);
  });
  it('reports a non-pending state before a stale epoch (the sweep ran: it is revoked)', () => {
    expect(() => assertRedeemable(locked({ state: 'revoked' }), 4n, T0)).toThrow(
      ApprovalNotPendingError,
    );
  });
});

describe('assertDue (T073)', () => {
  it('passes at and after expires_at', () => {
    expect(() => assertDue(locked(), plus(60_000))).not.toThrow();
    expect(() => assertDue(locked(), plus(90_000))).not.toThrow();
  });
  it('refuses a tick that fires early', () => {
    expect(() => assertDue(locked(), plus(59_999))).toThrow(ApprovalNotDueError);
  });
  it('refuses a request that is no longer pending', () => {
    expect(() => assertDue(locked({ state: 'approved' }), plus(90_000))).toThrow(
      ApprovalNotPendingError,
    );
  });
});

describe('assertRequestable', () => {
  it('passes a live decision', () => {
    expect(() => assertRequestable({ id: 'd' })).not.toThrow();
    expect(() =>
      assertRequestable({ id: 'd', consumedAt: null, invalidatedReason: null }),
    ).not.toThrow();
  });
  it('refuses a consumed decision', () => {
    expect(() => assertRequestable({ id: 'd', consumedAt: T0 })).toThrow(
      DecisionAlreadyConsumedError,
    );
  });
  it('refuses an invalidated decision', () => {
    expect(() => assertRequestable({ id: 'd', invalidatedReason: 'epoch_bump' })).toThrow(
      DecisionNotAllowedError,
    );
  });
});
