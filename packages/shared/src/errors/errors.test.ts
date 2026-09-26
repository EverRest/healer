import { describe, expect, it } from 'vitest';
import { HealerError, httpStatusFor, toErrorBody } from './index.js';

describe('error format', () => {
  it('carries a code, a message and the correlation identifier', () => {
    const body = new HealerError('NOT_FOUND', 'issue not found').toBody('c-1');
    expect(body).toEqual({ code: 'NOT_FOUND', message: 'issue not found', correlationId: 'c-1' });
  });

  it('maps a foreign identifier to 404 and a ceiling breach to 422', () => {
    expect(httpStatusFor('NOT_FOUND')).toBe(404);
    expect(httpStatusFor('CEILING_EXCEEDED')).toBe(422);
    expect(httpStatusFor('PROTOCOL_UNSUPPORTED')).toBe(426);
  });

  it('never returns an unexpected error’s message to a caller', () => {
    const body = toErrorBody(new Error('select * from issue where tenant_id = $1 failed'), 'c-2');
    expect(body).toEqual({ code: 'INTERNAL', message: 'Internal error', correlationId: 'c-2' });
  });
});
