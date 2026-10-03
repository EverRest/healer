import { describe, expect, it } from 'vitest';
import { periodKeyFor, periodWindow } from './budget-period.js';

describe('periodWindow', () => {
  it('a day window is [00:00Z, next 00:00Z) around the instant', () => {
    expect(periodWindow('day', new Date('2026-10-02T23:55:00Z'))).toEqual({
      start: new Date('2026-10-02T00:00:00Z'),
      end: new Date('2026-10-03T00:00:00Z'),
    });
  });

  it('a month window rolls over the year', () => {
    expect(periodWindow('month', new Date('2026-12-31T23:59:59Z'))).toEqual({
      start: new Date('2026-12-01T00:00:00Z'),
      end: new Date('2027-01-01T00:00:00Z'),
    });
  });

  it('the per-issue period has no calendar window', () => {
    expect(periodWindow('issue', new Date('2026-10-02T00:00:00Z'))).toBeNull();
  });
});

// T062 (FR-011, spec edge case): the evaluator reads no clock, so the instant is an input. The
// key is a pure function of (period, instant) in UTC — never the host's local zone, because a
// budget window that moves with the server's TZ is a window nobody can audit.
describe('periodKeyFor', () => {
  it('day keys are UTC calendar days, and flip exactly at 00:00:00.000Z', () => {
    expect(periodKeyFor('day', new Date('2026-10-02T23:59:59.999Z'))).toBe('2026-10-02');
    expect(periodKeyFor('day', new Date('2026-10-03T00:00:00.000Z'))).toBe('2026-10-03');
  });

  it('month keys are UTC calendar months', () => {
    expect(periodKeyFor('month', new Date('2026-10-31T23:59:59.999Z'))).toBe('2026-10');
    expect(periodKeyFor('month', new Date('2026-11-01T00:00:00.000Z'))).toBe('2026-11');
  });

  it('the per-issue period has no calendar: one key for the life of the issue', () => {
    expect(periodKeyFor('issue', new Date('2026-01-01T00:00:00Z'))).toBe('issue');
    expect(periodKeyFor('issue', new Date('2030-06-01T12:00:00Z'))).toBe('issue');
  });

  it('pads single-digit months and days', () => {
    expect(periodKeyFor('day', new Date('2026-03-04T05:06:07Z'))).toBe('2026-03-04');
    expect(periodKeyFor('month', new Date('2026-03-04T05:06:07Z'))).toBe('2026-03');
  });
});
