import type { Prisma } from '@healer/prisma-client';
import { BUDGET_LOCK_WAIT_MS } from '../domain/budget-bounds.js';

// ADR 0015: a transaction-scoped advisory lock with a bounded wait. Used by the budget charge
// (`policy.budget:<tenant>`) and by the action-limit counts (`policy.action_limit:<scope>`, T054).

/** Postgres `lock_not_available` (55P03), however Prisma wraps it. */
export function isLockTimeout(error: unknown): boolean {
  const text = `${(error as { message?: string })?.message ?? ''} ${JSON.stringify((error as { meta?: unknown })?.meta ?? '')}`;
  return text.includes('55P03') || /lock timeout/i.test(text);
}

/** Takes the lock for `key` until the transaction ends, waiting at most `BUDGET_LOCK_WAIT_MS`;
 *  throws `onTimeout()` past it. */
export async function takeBoundedLock(
  tx: Prisma.TransactionClient,
  key: string,
  onTimeout: () => Error,
): Promise<void> {
  await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${BUDGET_LOCK_WAIT_MS}ms`}, true)`;
  try {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  } catch (error) {
    if (isLockTimeout(error)) throw onTimeout();
    throw error;
  }
  await tx.$executeRaw`SELECT set_config('lock_timeout', '0', true)`;
}
