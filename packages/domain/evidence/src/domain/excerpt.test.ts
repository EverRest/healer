import { describe, expect, it } from 'vitest';
import { boundExcerpt } from './excerpt.js';

describe('boundExcerpt (R-05, FR-011)', () => {
  it('passes through null unchanged, never truncated', () => {
    expect(boundExcerpt(null, 10)).toEqual({ excerpt: null, excerptTruncated: false });
  });

  it('passes through a string shorter than the limit unchanged', () => {
    expect(boundExcerpt('short', 10)).toEqual({ excerpt: 'short', excerptTruncated: false });
  });

  it('passes through a string exactly at the limit unchanged', () => {
    expect(boundExcerpt('123456789', 9)).toEqual({
      excerpt: '123456789',
      excerptTruncated: false,
    });
  });

  it('bounds a string over the limit to a head-and-tail extract and marks it truncated (R-05)', () => {
    const raw = 'A'.repeat(10) + 'MIDDLE' + 'B'.repeat(10);
    const result = boundExcerpt(raw, 6);
    expect(result).toEqual({ excerpt: 'AAABBB', excerptTruncated: true });
  });

  it('the extract is never longer than maxLength', () => {
    const result = boundExcerpt('x'.repeat(1000), 50);
    expect(result.excerpt).toHaveLength(50);
    expect(result.excerptTruncated).toBe(true);
  });

  it('drops the middle whole, never a lone surrogate half of a multi-byte character', () => {
    // 3 emoji = 3 code points but 6 UTF-16 code units; slicing by code unit could cut one in half.
    const result = boundExcerpt('😀😀😀', 2);
    expect(result).toEqual({ excerpt: '😀😀', excerptTruncated: true });
    expect(Array.from(result.excerpt ?? '')).toHaveLength(2);
  });

  it('rejects a non-positive maxLength', () => {
    expect(() => boundExcerpt('x', 0)).toThrow(/positive/);
    expect(() => boundExcerpt('x', -1)).toThrow(/positive/);
  });
});
