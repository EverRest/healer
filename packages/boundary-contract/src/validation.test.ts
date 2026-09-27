import { describe, expect, it } from 'vitest';
import { validateEgress, validateIngress } from './validation.js';

const VALID = { kind: 'file_path', path: 'a/b.ts' };
const INVALID = { kind: 'file_path', path: 'a/b.ts', rawLogBody: 'should never cross' };

describe('validateEgress / validateIngress (012 T041, FR-022)', () => {
  it('egress accepts a payload matching the closed schema', () => {
    expect(validateEgress(VALID).ok).toBe(true);
  });

  it('egress rejects a payload with a free-form field — it is never sent', () => {
    const result = validateEgress(INVALID);
    expect(result.ok).toBe(false);
    expect(result.errors?.length).toBeGreaterThan(0);
  });

  it('ingress independently rejects the same invalid payload — it does not trust egress already ran', () => {
    expect(validateIngress(INVALID).ok).toBe(false);
  });

  it('ingress accepts a payload egress would also accept', () => {
    expect(validateIngress(VALID).ok).toBe(true);
  });
});
