import { describe, expect, it } from 'vitest';
import { parseInstantLiteral } from './instant-literal.js';

describe('parseInstantLiteral (002 batch 9 round 3, FR-002)', () => {
  it('parses a UTC (Z) literal to the correct timestamp', () => {
    expect(parseInstantLiteral('2026-01-01T00:00:00Z')).toBe(
      new Date('2026-01-01T00:00:00Z').getTime(),
    );
  });

  it('parses a literal carrying an explicit offset', () => {
    expect(parseInstantLiteral('2026-01-01T00:00:00+02:00')).toBe(
      new Date('2026-01-01T00:00:00+02:00').getTime(),
    );
  });

  it('rejects an offset-less literal rather than guessing the local timezone', () => {
    expect(Number.isNaN(parseInstantLiteral('2026-01-01T00:00:00'))).toBe(true);
  });

  it('rejects a date-only literal', () => {
    expect(Number.isNaN(parseInstantLiteral('2026-01-01'))).toBe(true);
  });

  it('rejects garbage', () => {
    expect(Number.isNaN(parseInstantLiteral('not-a-date'))).toBe(true);
  });
});
