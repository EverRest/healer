import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { REDACTED, createLogger, withContext } from './index.js';

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
