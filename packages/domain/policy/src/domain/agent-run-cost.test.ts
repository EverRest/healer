import { describe, expect, it } from 'vitest';
import { toCostDecimal } from './agent-run-cost.js';

describe('toCostDecimal (012 T094)', () => {
  it('does not let float drift reach the column', () => {
    expect(toCostDecimal(0.1 + 0.2)).toBe('0.300000');
    expect(toCostDecimal(1.005)).toBe('1.005000');
    expect(toCostDecimal(0)).toBe('0.000000');
  });

  it('rounds beyond six decimals to the column scale rather than refusing the charge', () => {
    expect(toCostDecimal(0.0000004)).toBe('0.000000');
    expect(toCostDecimal(0.0000006)).toBe('0.000001');
    expect(toCostDecimal(12.3456789)).toBe('12.345679');
  });

  it('refuses negative, non-finite and over-range costs', () => {
    expect(() => toCostDecimal(-0.000001)).toThrow();
    expect(() => toCostDecimal(Number.NaN)).toThrow();
    expect(() => toCostDecimal(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => toCostDecimal(1_000_000)).toThrow();
    expect(toCostDecimal(999_999.999999)).toBe('999999.999999');
  });
});
