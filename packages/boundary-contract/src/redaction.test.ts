import { describe, expect, it } from 'vitest';
import { redact } from './redaction.js';

describe('redact (012 T047, R-05)', () => {
  it('clears an item the policy judges safe', () => {
    const result = redact(
      'safe excerpt',
      () => true,
      (x) => x,
    );
    expect(result).toEqual({ status: 'clear', value: 'safe excerpt' });
  });

  it('withholds an item the policy cannot clear, recording a collection_gap — never truncates', () => {
    const result = redact(
      'unsafe excerpt',
      () => false,
      () => 'excerpt-id-1',
    );
    expect(result.status).toBe('withheld');
    if (result.status === 'withheld') {
      expect(result.gap).toEqual({
        kind: 'collection_gap',
        what: 'excerpt-id-1',
        why: 'redactor could not establish the item was safe to transmit',
        withheldByRedaction: true,
      });
    }
  });

  it('has exactly two outcomes — there is no partial/truncated variant to reach for', () => {
    const outcome = redact(
      'x',
      () => false,
      (x) => x,
    );
    expect(['clear', 'withheld']).toContain(outcome.status);
  });
});
