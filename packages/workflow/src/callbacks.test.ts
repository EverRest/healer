import { describe, expect, it } from 'vitest';
import { consume, hashToken, issue, unmatched } from './callbacks.js';

const RUN = '0193a1f0-0000-7000-8000-0000000000cc';
const TENANT = '0193a1f0-0000-7000-8000-000000000001';
const now = new Date('2026-09-24T12:00:00Z');
const later = new Date('2026-09-24T12:30:00Z');
const expiresAt = new Date('2026-09-24T12:10:00Z');

const issued = () =>
  issue({ runId: RUN, tenantId: TENANT, kind: 'ci_result', expiresAt, token: 's3cret' });

describe('callback issuance', () => {
  it('stores the token hashed, so a callback URL in a CI log is not a credential', () => {
    const { record, token } = issued();
    expect(record.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(record)).not.toContain(token);
  });
});

describe('consuming a callback', () => {
  it('accepts the first valid delivery', () => {
    const { record, token } = issued();
    const outcome = consume(record, token, now);
    expect(outcome.status).toBe('accepted');
    expect(outcome.status === 'accepted' && outcome.record.consumedAt).toEqual(now);
  });

  it('counts a repeat and changes nothing else', () => {
    const { record, token } = issued();
    const first = consume(record, token, now);
    const consumed = first.status === 'accepted' ? first.record : record;

    const second = consume(consumed, token, now);
    expect(second.status).toBe('duplicate');
    expect(second.status === 'duplicate' && second.record.receivedCount).toBe(2);
    expect(second.status === 'duplicate' && second.record.consumedAt).toEqual(now);
  });

  it('reports a late delivery as expired rather than swallowing it', () => {
    const { record, token } = issued();
    const outcome = consume(record, token, later);
    expect(outcome.status).toBe('expired');
  });

  it('rejects a wrong token without revealing whether the run exists', () => {
    const { record } = issued();
    const outcome = consume(record, 'guess', now);
    expect(outcome).toEqual({ status: 'rejected', reason: 'token_mismatch' });
  });
});

describe('unmatched delivery', () => {
  it('is recorded with a hash prefix — enough to correlate, not enough to replay', () => {
    const delivery = unmatched('s3cret', 'ci_result', 'unknown_token', now);
    expect(delivery.tokenHashPrefix).toHaveLength(12);
    expect(hashToken('s3cret')).toContain(delivery.tokenHashPrefix);
    expect(delivery.reason).toBe('unknown_token');
  });
});
