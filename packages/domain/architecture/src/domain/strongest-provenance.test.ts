import { describe, expect, it } from 'vitest';
import { compareStrongestFirst, type RankedProvenance } from './strongest-provenance.js';

const at = new Date('2026-10-02T00:00:00Z');
const row = (id: string, strength: number, recordedAt = at): RankedProvenance => ({
  id,
  strength,
  recordedAt,
});

describe('compareStrongestFirst', () => {
  it('orders by strength, then earliest recorded, then id — whatever order the rows arrive in', () => {
    const rows = [
      row('c', 30),
      row('z', 50, new Date(at.getTime() + 1)),
      row('b', 50),
      row('a', 50),
    ];
    expect([...rows].sort(compareStrongestFirst).map((r) => r.id)).toEqual(['a', 'b', 'z', 'c']);
    expect(
      [...rows]
        .reverse()
        .sort(compareStrongestFirst)
        .map((r) => r.id),
    ).toEqual(['a', 'b', 'z', 'c']);
  });
});
