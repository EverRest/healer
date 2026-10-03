import { describe, expect, it } from 'vitest';
import { formatEntry, parseRef } from './runner-resolve-ref.mjs';

const REF = '0190b7a0-0000-7000-8000-0000000000aa';

describe('runner-resolve-ref (003 T022, R-08)', () => {
  it('takes the reference from the argument, or from REF', () => {
    expect(parseRef({ argv: ['node', 's', REF], env: {} })).toBe(REF);
    expect(parseRef({ argv: ['node', 's'], env: { REF } })).toBe(REF);
  });

  it('refuses a missing reference and anything that is not a UUID — it is never a path fragment', () => {
    expect(() => parseRef({ argv: ['node', 's'], env: {} })).toThrow(/usage/);
    expect(() => parseRef({ argv: ['node', 's', '../../etc/passwd'], env: {} })).toThrow(
      /not a localRef/,
    );
  });

  it('prints what a human needs: what it was, why it did not cross, where it came from, and the original', () => {
    const text = formatEntry({
      localRef: REF,
      kind: 'withheld',
      collectorKey: 'loki_logs',
      itemClass: 'error_signature',
      reasonCode: 'redaction_withheld',
      detector: 'private_key_block',
      sourceLocator: 'loki:1',
      observedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-02-01T00:00:00.000Z',
      originalTruncated: false,
      original: 'the raw line',
    });
    expect(text).toContain('nothing crossed the boundary');
    expect(text).toContain('detector: private_key_block');
    expect(text).toContain('the raw line');
  });
});
