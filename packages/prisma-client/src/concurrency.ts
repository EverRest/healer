import { Prisma } from '@healer/prisma-generated';

/**
 * True for errors that mean another transaction got in the way — reread and retry — as opposed to
 * a bug:
 * - `P2034`: a serialization failure or deadlock in one of Prisma's own generated queries;
 * - `P2010` wrapping SQLSTATE `40001` / `40P01`: the same failures raised by a raw query, which
 *   Prisma does not fold into `P2034`;
 * - an unclassified `PrismaClientUnknownRequestError` whose message carries SQLSTATE `40001` /
 *   `40P01`: how a typed (non-raw) query reports the same failures;
 * - `P2028`: the interactive transaction could not be started in time or was closed under us.
 * Anything else is not a concurrency conflict.
 */
export function isConcurrencyConflict(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    return /code: "(40001|40P01)"/.test(error.message);
  }
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  const sqlstate = (error.meta as { code?: string } | undefined)?.code;
  return (
    error.code === 'P2034' ||
    error.code === 'P2028' ||
    (error.code === 'P2010' && (sqlstate === '40001' || sqlstate === '40P01'))
  );
}

/** Domain packages supply `makeError` so the translated error names their own resource. */
export function translateConcurrencyError(error: unknown, makeError: () => Error): unknown {
  return isConcurrencyConflict(error) ? makeError() : error;
}

export async function withConcurrencyTranslation<T>(
  fn: () => Promise<T>,
  makeError: () => Error,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw translateConcurrencyError(error, makeError);
  }
}
