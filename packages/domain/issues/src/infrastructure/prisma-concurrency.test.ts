import { describe, expect, it } from 'vitest';
import { Prisma } from '@healer/prisma-client';
import { ConcurrentModificationError } from '../domain/state-machine.js';
import { translateConcurrencyError, withConcurrencyTranslation } from './prisma-concurrency.js';

/**
 * Which Prisma errors mean "another transaction got in the way, reread and retry" (001 T049/T050):
 * a serialization failure or deadlock, however Prisma chose to wrap it, and a transaction it could
 * not start in time. Everything else must pass through untouched — a translation that swallowed a
 * real bug as a retryable conflict would be worse than none.
 */
function known(code: string, meta?: Record<string, unknown>): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('boom', {
    code,
    clientVersion: 'test',
    ...(meta ? { meta } : {}),
  });
}

/** What a deadlock in a typed (non-raw) query really looks like: Prisma does not classify it. */
function unknown(message: string): Prisma.PrismaClientUnknownRequestError {
  return new Prisma.PrismaClientUnknownRequestError(message, { clientVersion: 'test' });
}
const PG = (code: string) =>
  `Invalid \`tx.x()\` invocation\nConnectorError { kind: QueryError(PostgresError { code: "${code}", message: "deadlock detected" }) }`;

describe('translateConcurrencyError (001 T049/T050)', () => {
  it.each([
    ['P2034 (Prisma’s own generated query)', known('P2034')],
    ['P2028 (transaction could not be started or was closed)', known('P2028')],
    ['P2010 wrapping 40001 (raw serialization failure)', known('P2010', { code: '40001' })],
    ['P2010 wrapping 40P01 (raw deadlock)', known('P2010', { code: '40P01' })],
    ['an unclassified error carrying 40P01 (typed-query deadlock)', unknown(PG('40P01'))],
    ['an unclassified error carrying 40001', unknown(PG('40001'))],
  ])('turns %s into ConcurrentModificationError', (_label, error) => {
    expect(translateConcurrencyError(error)).toBeInstanceOf(ConcurrentModificationError);
  });

  it.each([
    ['a unique violation', known('P2002')],
    ['a raw error with another SQLSTATE', known('P2010', { code: '23514' })],
    ['an unclassified error carrying another SQLSTATE', unknown(PG('23505'))],
    ['a plain Error', new Error('nope')],
    ['a non-error', 'x'],
  ])('leaves %s alone', (_label, error) => {
    expect(translateConcurrencyError(error)).toBe(error);
  });

  it('withConcurrencyTranslation rethrows the translated error, and passes results through', async () => {
    await expect(withConcurrencyTranslation(async () => 7)).resolves.toBe(7);
    await expect(
      withConcurrencyTranslation(() => Promise.reject(known('P2034'))),
    ).rejects.toBeInstanceOf(ConcurrentModificationError);
  });
});
