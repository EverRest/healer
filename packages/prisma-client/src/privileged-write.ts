import type { Prisma, PrismaClient } from '@healer/prisma-generated';

/**
 * The one way to switch off the append-only rules (`reject_mutation_unless_privileged`, migration
 * 20260927000000; R-03). The migration says T052/T053 "must wrap this in one helper that only ever
 * issues `SET LOCAL` — never call `set_config`/`SET` ad hoc at each call site", and this is it.
 *
 * It opens the transaction itself and hands the caller only the transaction client. So a caller
 * cannot issue the `set_config`, cannot forget the `true` that makes it transaction-local (a bare
 * session-level `SET` survives onto whatever request reuses that pooled connection next), and
 * cannot run its own writes outside the scope: when `fn` returns or throws, the transaction ends
 * and the setting goes with it.
 *
 * **The bypass covers every statement in the transaction, not just the one that needs it** — the
 * triggers accept any UPDATE, DELETE or TRUNCATE on every append-only table while it is on. Keep
 * `fn` to the destructive statement and the audit write that describes it; do not do a
 * read-modify-write in here.
 *
 * `options` are Prisma's interactive-transaction bounds, passed through unchanged (omitted: Prisma's
 * 5 s). Note `timeout` does not cut a statement blocked on a lock short — set `lock_timeout` inside
 * `fn` for that.
 */
export async function withPrivilegedWrite<T>(
  prisma: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { readonly maxWait?: number; readonly timeout?: number },
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('healer.privileged_write', 'on', true)`;
    return fn(tx);
  }, options);
}
