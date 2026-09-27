import { describe, expect, it } from 'vitest';
import { OutboundBuffer } from './outbound-buffer.js';

describe('OutboundBuffer (012 T046, FR-021)', () => {
  it('holds items up to its bound without loss', () => {
    const buf = new OutboundBuffer<string>(3);
    buf.push('a', (x) => x);
    buf.push('b', (x) => x);
    buf.push('c', (x) => x);
    expect(buf.size).toBe(3);
    expect(buf.drainGaps()).toEqual([]);
    expect(buf.drain()).toEqual(['a', 'b', 'c']);
  });

  it('drops the oldest item on overflow and records a collection_gap, never blocking the push', () => {
    const buf = new OutboundBuffer<string>(2);
    buf.push('a', (x) => x);
    buf.push('b', (x) => x);
    buf.push('c', (x) => x); // overflow: 'a' dropped
    expect(buf.drain()).toEqual(['b', 'c']);
    const gaps = buf.drainGaps();
    expect(gaps).toHaveLength(1);
    const [gap] = gaps;
    expect(gap).toMatchObject({ kind: 'collection_gap', what: 'a', withheldByRedaction: false });
    expect(gap?.why).toMatch(/overflow/);
  });

  it('never truncates an item — it is dropped whole or not at all', () => {
    const buf = new OutboundBuffer<{ id: string; big: string }>(1);
    buf.push({ id: '1', big: 'x'.repeat(1000) }, (x) => x.id);
    buf.push({ id: '2', big: 'y'.repeat(1000) }, (x) => x.id);
    const remaining = buf.drain();
    expect(remaining[0]?.big).toHaveLength(1000);
  });

  it('bounds the gap log itself — a sustained overflow does not grow gaps without limit', () => {
    const buf = new OutboundBuffer<string>(2);
    for (let i = 0; i < 100; i++) buf.push(`item-${i}`, (x) => x);
    const gaps = buf.drainGaps();
    expect(gaps.length).toBeLessThanOrEqual(2);
    expect(gaps.at(-1)?.what).toBe('item-97');
  });

  it('rejects a non-positive bound — an unbounded buffer is exactly what this exists to prevent', () => {
    expect(() => new OutboundBuffer(0)).toThrow();
    expect(() => new OutboundBuffer(-1)).toThrow();
  });
});
