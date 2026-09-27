import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { REDACTED, createLogger, withContext } from './index.js';

// Built from parts, not a literal header: this file is itself scanned by `secret-scan` once
// committed, and a literal `-----BEGIN...PRIVATE KEY-----` here would fail every `make ci`
// (scripts/secret-scan.test.ts hit the same thing first).
const PEM_HEADER = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');
const PEM_HEADER_PATTERN = new RegExp(['-----BEGIN', '[A-Z ]*PRIVATE KEY-----'].join(' '));

function capture(): { sink: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  return {
    sink,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('createLogger', () => {
  it('redacts secret-bearing and customer-content fields', () => {
    const { sink, lines } = capture();
    const logger = createLogger({ level: 'info' }, sink);

    logger.info({ token: 'abc', credentialRef: 'vault://x', nested: { apiKey: 'k' } }, 'call');
    logger.info({ body: 'raw log line from the customer', patch: 'diff --git' }, 'collected');

    const [first, second] = lines();
    expect(first?.token).toBe(REDACTED);
    expect(first?.credentialRef).toBe(REDACTED);
    expect((first?.nested as Record<string, unknown>)?.apiKey).toBe(REDACTED);
    expect(second?.body).toBe(REDACTED);
    expect(second?.patch).toBe(REDACTED);
  });

  // 012 T062, FR-035: a sampled check that nothing dangerous slipped through in some field the
  // tests above did not name individually — asserts against the raw serialized line, not one
  // field at a time. This does not replace structured redaction with pattern-matching (unreliable
  // by nature); it only confirms the redaction that ran actually removed the raw text.
  it('leaves no private-key material or credentialed URL anywhere in the rendered line', () => {
    const { sink, lines } = capture();
    const logger = createLogger({ level: 'info' }, sink);

    logger.info({ credentialRef: `${PEM_HEADER}\nfake\n-----END-----` }, 'holds a key');
    logger.info({ credentialRef: 'postgresql://user:hunter2@host:5432/db' }, 'holds a dsn');

    for (const line of lines()) {
      const raw = JSON.stringify(line);
      expect(raw).not.toMatch(PEM_HEADER_PATTERN);
      expect(raw).not.toMatch(/:\/\/[^/\s"]+:[^/\s"]+@/);
    }
  });

  it('binds tenant and correlation to every line of a child logger', () => {
    const { sink, lines } = capture();
    const logger = withContext(createLogger({ level: 'info' }, sink), {
      tenantId: 't-1',
      correlationId: 'c-1',
    });

    logger.info('first');
    logger.warn('second');

    for (const line of lines()) {
      expect(line.tenantId).toBe('t-1');
      expect(line.correlationId).toBe('c-1');
    }
  });
});
