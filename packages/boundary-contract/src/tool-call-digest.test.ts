import { describe, expect, it } from 'vitest';
import { digestToolCallArguments } from './tool-call-digest.js';

describe('digestToolCallArguments (012 T059, FR-033)', () => {
  it('produces a stable digest for the same arguments', () => {
    const args = { path: 'a.ts', line: 10 };
    expect(digestToolCallArguments(args)).toBe(digestToolCallArguments(args));
  });

  it('produces the same digest regardless of key order — a real value, not a serialization accident', () => {
    expect(digestToolCallArguments({ a: 1, b: 2 })).toBe(digestToolCallArguments({ b: 2, a: 1 }));
  });

  it('produces the same digest regardless of nested key order', () => {
    const x = { outer: { a: 1, b: 2 }, id: 'x' };
    const y = { id: 'x', outer: { b: 2, a: 1 } };
    expect(digestToolCallArguments(x)).toBe(digestToolCallArguments(y));
  });

  it('produces a different digest for different arguments — it is not a constant', () => {
    expect(digestToolCallArguments({ path: 'a.ts' })).not.toBe(
      digestToolCallArguments({ path: 'b.ts' }),
    );
  });

  it('never contains the argument value itself, only a fixed-length hex digest', () => {
    const digest = digestToolCallArguments({ secret: 'sk-super-secret-token' });
    expect(digest).not.toContain('secret');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
