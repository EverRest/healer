import { PEM_HEADER } from '../test-support.js';
import { describe, expect, it } from 'vitest';
import { DETECTOR_KEYS, REDACTION_RULESETS } from '@healer/boundary-contract';
import { DETECTORS } from './detectors.js';
import { Redactor } from './redactor.js';

const redactor = Redactor.forVersion(1, { tenantId: 'tenant-1', pseudonymKey: Buffer.from('k') })!;

function excerpt(text: string) {
  return redactor.clearExcerpt(text);
}

describe('redaction ruleset v1 (003 T017, T018, R-07a)', () => {
  it('implements every detector the published ruleset names — a missing one cannot ship', () => {
    expect(Object.keys(DETECTORS).sort()).toEqual([...DETECTOR_KEYS].sort());
    expect(REDACTION_RULESETS[1]!.detectors).toEqual(DETECTOR_KEYS);
  });

  it('refuses a ruleset version it does not know — a disabled ruleset withholds (FR-009)', () => {
    expect(
      Redactor.forVersion(99, { tenantId: 't', pseudonymKey: Buffer.from('k') }),
    ).toBeUndefined();
  });

  describe('clears by replacement', () => {
    it('email_address → a stable per-tenant pseudonym, different per tenant', () => {
      const a = excerpt('Cannot read properties of undefined for jane.doe@example.com');
      const again = excerpt('Cannot read properties of undefined for jane.doe@example.com');
      expect(a).toEqual(again);
      expect(a.status === 'clear' && a.text).toMatch(/<email:[0-9a-f]{8}>/);
      expect(JSON.stringify(a)).not.toContain('jane.doe');
      const other = Redactor.forVersion(1, {
        tenantId: 'tenant-2',
        pseudonymKey: Buffer.from('k'),
      })!;
      expect(other.clearExcerpt('connection refused jane.doe@example.com')).not.toEqual(
        redactor.clearExcerpt('connection refused jane.doe@example.com'),
      );
    });

    it('bearer_token → the whole value is removed, never replaced by a derivative', () => {
      const r = excerpt('request failed Authorization: Bearer abc.def-ghi_123 timeout');
      expect(JSON.stringify(r)).not.toContain('abc.def');
      const jwt = excerpt('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2ln rejected');
      expect(JSON.stringify(jwt)).not.toContain('eyJ');
      expect(JSON.stringify(excerpt('failed password=hunter2 timeout'))).not.toContain('hunter2');
    });

    it('connection_string → credentials removed, host and database kept', () => {
      const r = excerpt('connection refused postgres://app:s3cret@db.internal:5432/orders');
      expect(r.status).toBe('clear');
      const text = r.status === 'clear' ? r.text : '';
      expect(text).not.toContain('s3cret');
      expect(text).not.toContain('app:');
      expect(text).toContain('db.internal');
      expect(text).toContain('/orders');
    });

    it('ip_address → network portion kept, host portion dropped', () => {
      const r = excerpt('connection refused from 10.20.30.41');
      expect(r.status === 'clear' && r.text).toContain('10.20.30.x');
      expect(JSON.stringify(r)).not.toContain('30.41');
    });

    it('uuid_in_message_position → a positional placeholder, equal uuids share one', () => {
      const id = '0190b7a0-1111-7222-8333-444455556666';
      const r = excerpt(`order ${id} failed then ${id} retry`);
      expect(r.status === 'clear' && r.text).toBe('order <uuid:1> failed then <uuid:1> retry');
    });

    it('numeric_identifier_run → a length-preserving placeholder', () => {
      const r = excerpt('timeout for account 12345678');
      expect(r.status === 'clear' && r.text).toBe('timeout for account <num:8>');
    });
  });

  describe('fails closed — the whole item is withheld, never rewritten', () => {
    const cases: [string, string, string][] = [
      ['private_key_block', `error loading ${PEM_HEADER}\nMIIE`, 'private_key_block'],
      ['private_key_block (any PEM header)', '-----BEGIN CERTIFICATE----- x', 'private_key_block'],
      ['payment_instrument (Luhn)', 'charge failed card 4242 4242 4242 4242', 'payment_instrument'],
      ['national_identifier (US SSN)', 'lookup failed for 123-45-6789', 'national_identifier'],
      ['national_identifier (UK NINO)', 'lookup failed for AB 12 34 56 C', 'national_identifier'],
      [
        'connection_string (credential unlocatable)',
        'connect failed mysql://@@weird:::pw@host/db',
        'connection_string',
      ],
      [
        'numeric run inside an unclassifiable word',
        'failed for order12345678x',
        'numeric_identifier_run',
      ],
    ];
    for (const [name, text, detector] of cases) {
      it(name, () => {
        expect(excerpt(text)).toEqual({ status: 'withheld', detector });
      });
    }

    it('does not treat a digit run with no Luhn-valid window as a card', () => {
      // no 13–19 digit window of this run is Luhn-valid
      expect(excerpt('timeout for account 1234 5678 9012 3457').status).toBe('clear');
    });
  });

  describe('free_text_span never clears (default-deny for text no detector structured)', () => {
    it('omits the excerpt and flags redaction-dominated rather than sending a name', () => {
      const r = excerpt('User Alice Johnson not found in tenant Acme Corp');
      expect(r).toEqual({
        status: 'clear',
        text: undefined,
        truncated: false,
        redactionDominated: true,
      });
    });

    it('lets a message made only of template vocabulary and structure through', () => {
      const r = excerpt(
        "TypeError: Cannot read properties of undefined (reading 'id') at src/a.ts:12:5",
      );
      expect(r.status === 'clear' && r.text).toContain('Cannot read properties of undefined');
      expect(r.status === 'clear' && r.redactionDominated).toBe(false);
    });

    it('keeps an excerpt that survives redaction with no signal left, flagged (T027)', () => {
      const r = excerpt('jane@example.com 12345678');
      expect(r.status).toBe('clear');
      expect(r.status === 'clear' && r.redactionDominated).toBe(true);
      expect(r.status === 'clear' && r.text).toBeDefined();
    });
  });

  describe('bounds', () => {
    it('cuts at a word boundary within the bound and says so', () => {
      const r = excerpt(('cannot read ' as string).repeat(200));
      expect(r.status === 'clear' && r.truncated).toBe(true);
      expect(r.status === 'clear' && (r.text ?? '').length).toBeLessThanOrEqual(500);
      // never ends inside a word: the cut lands on a whole `cannot` or `read`
      expect(r.status === 'clear' && r.text).toMatch(/(?:^|\s)(?:cannot|read)$/);
    });

    it('never scans past the capture bound — a 40 MB payload costs a bounded scan', () => {
      const huge = 'cannot read '.repeat(3_500_000);
      const started = Date.now();
      const r = excerpt(huge);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(r.status === 'clear' && r.truncated).toBe(true);
    });
  });

  describe('shape fields', () => {
    it('scrubs every string leaf, replacing an email in a field and withholding a card', () => {
      const ok = redactor.scrubShape({
        kind: 'commit_ref',
        authorHandle: 'jane@example.com',
        sha: 'abc123',
      });
      expect(ok.status === 'clear' && ok.value.authorHandle).toMatch(/^h_[0-9a-f]{8}$/);
      const bad = redactor.scrubShape({
        kind: 'file_path',
        path: 'uploads/4242424242424242/x.png',
      });
      expect(bad).toEqual({ status: 'withheld', detector: 'payment_instrument' });
    });

    it('leaves a commit sha alone', () => {
      const sha = '3f9a6b2c1d0e4f5a6b7c8d9e0f1a2b3c4d5e6f70';
      const ok = redactor.scrubShape({ kind: 'commit_ref', sha });
      expect(ok.status === 'clear' && ok.value.sha).toBe(sha);
    });
  });
});

describe('review regressions — default-deny holds beyond ASCII and beyond the happy formats', () => {
  const sendable = (text: string) => {
    const r = redactor.clearExcerpt(text);
    return r.status === 'clear' ? r.text : '<withheld>';
  };

  it('drops a non-Latin name — a token with no ASCII letter is not "empty", it is text', () => {
    for (const name of ['Иван Петров', '山田太郎', 'أحمد', '张伟']) {
      expect(sendable(`TypeError: User ${name} not found`)).toBeUndefined();
    }
  });

  it('reads fullwidth digits as digits: a fullwidth card number is still a card', () => {
    expect(redactor.clearExcerpt('charge failed ４２４２ ４２４２ ４２４２ ４２４２')).toEqual({
      status: 'withheld',
      detector: 'payment_instrument',
    });
  });

  it('does not let input forge a placeholder to smuggle text through', () => {
    expect(sendable('failed <conn:x://Alice-Johnson-12-Main-Street/ssn>')).toBeUndefined();
    expect(sendable('failed <email:deadbeef> Alice Johnson')).toBeUndefined();
  });

  it('does not clear name-like words: ALL-CAPS E-names and common-word first names', () => {
    expect(sendable('USER ERIC EMMA ETHAN not found')).toBeUndefined();
    expect(sendable('Will Smith not found')).toBeUndefined();
    expect(sendable('failed with ECONNREFUSED')).toContain('ECONNREFUSED');
  });

  it('catches a card number in every common separator and inside a longer digit run', () => {
    for (const text of [
      'account 4242.4242.4242.4242',
      'account 4242/4242/4242/4242',
      'order 12345 4242 4242 4242 4242 failed',
      'account 4242424242424242',
    ]) {
      expect(redactor.clearExcerpt(text), text).toEqual({
        status: 'withheld',
        detector: 'payment_instrument',
      });
    }
  });

  it('replaces an IPv4 address that ends a sentence, and compressed IPv6', () => {
    expect(sendable('connection refused from 10.20.30.41.')).toBe(
      'connection refused from <ip:10.20.30.x>.',
    );
    expect(sendable('connection refused from 2001:4860:4860::8888')).toMatch(/<ipv6:/);
    expect(sendable('connection refused from 2001:4860:4860::8888')).not.toContain('8888');
  });

  it('replaces phone-shaped numbers and removes a client_secret value', () => {
    expect(sendable('timeout for (415) 555-2671')).not.toContain('555');
    expect(sendable('timeout for 555-2671')).not.toContain('2671');
    expect(sendable('failed client_secret=12345 timeout')).not.toContain('12345');
  });

  it('pseudonymises a commit author handle, stably', () => {
    const a = redactor.scrubShape({ kind: 'commit_ref', authorHandle: 'Alice Johnson' });
    const b = redactor.scrubShape({ kind: 'commit_ref', authorHandle: 'Alice Johnson' });
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).not.toContain('Alice');
    expect(a.status === 'clear' && a.value.authorHandle).toMatch(/^h_[0-9a-f]{8}$/);
  });

  it('replaces a uuid, an ip and a long number in a structural field, without withholding a sha', () => {
    const r = redactor.scrubShape({
      kind: 'file_path',
      path: 'a/0190b7a0-1111-7222-8333-444455556666/10.20.30.41/12345678',
    });
    expect(JSON.stringify(r)).not.toContain('0190b7a0');
    expect(JSON.stringify(r)).not.toContain('10.20.30.41');
    expect(JSON.stringify(r)).not.toContain('12345678');
  });
});
