import { Prisma } from '@healer/prisma-client';
import { ConcurrentModificationError } from '../domain/state-machine.js';

/**
 * Errors that mean another transaction got in the way — reread and retry — as opposed to a bug:
 * - `P2034`: a serialization failure or deadlock in one of Prisma's own generated queries;
 * - `P2010` wrapping SQLSTATE `40001` / `40P01`: the same failures raised by a raw query, which
 *   Prisma does not fold into `P2034` (see `transition()`'s long comment on exactly this);
 * - an unclassified `PrismaClientUnknownRequestError` whose message carries SQLSTATE `40001` /
 *   `40P01`: how a typed (non-raw) query reports the same failures;
 * - `P2028`: the interactive transaction could not be started in time or was closed under us.
 * Anything else is returned unchanged.
 *
 * ponytail: `transition()` has its own inline copy of the first two — dedupe with it once the close
 * branch that is editing it has merged (QUESTIONS.md "001 T049/T050").
 */
export function translateConcurrencyError(error: unknown): unknown {
  // A deadlock in one of Prisma's typed queries arrives unclassified, with the Postgres SQLSTATE
  // only inside the message (`code: "40P01"`) — found by forcing one against `unmerge`.
  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    return /code: "(40001|40P01)"/.test(error.message)
      ? new ConcurrentModificationError('Issue')
      : error;
  }
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return error;
  const sqlstate = (error.meta as { code?: string } | undefined)?.code;
  const isConflict =
    error.code === 'P2034' ||
    error.code === 'P2028' ||
    (error.code === 'P2010' && (sqlstate === '40001' || sqlstate === '40P01'));
  return isConflict ? new ConcurrentModificationError('Issue') : error;
}

export async function withConcurrencyTranslation<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw translateConcurrencyError(error);
  }
}
