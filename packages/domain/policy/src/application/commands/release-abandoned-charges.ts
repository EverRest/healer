import { scope, type TenantContext } from '@healer/shared';
import { ABANDONED_CHARGE_TTL_MS } from '../../domain/budget-bounds.js';
import type { BudgetRepository } from '../../domain/budget-repository.js';

export interface ReleaseAbandonedChargesCommand {
  /** The instant "now" is, passed in — the command reads no clock. */
  readonly now: Date;
  /** Never shorter than `ABANDONED_CHARGE_TTL_MS`: a step still allowed to run must keep its
   *  charge. Longer is permitted (a more patient sweep), shorter is refused. */
  readonly ttlMs?: number;
}

/**
 * `ReleaseAbandonedCharges` (T060, review: silent-failure #1). A charge is the declared maximum of
 * an allowed AI step, held until a finished `agent_run` replaces it with the actual cost. If the
 * step never starts — the worker died, the workflow was cancelled — nothing ever will, and the
 * charge would hold budget forever, eventually locking an issue (or a tenant) out. This releases
 * the allowed, never-consumed, never-run decisions older than the TTL by setting
 * `invalidated_reason = 'charge_abandoned'` (a member of the closed `INVALIDATED_REASONS`), which
 * is what stops them counting.
 *
 * It is the only release path, and it is a command: **no production caller schedules it** — this
 * repository has no scheduler, the same gap `sweepRevokedApprovals` and 001's staleness sweep carry.
 * Whoever builds the sweep worker (012) calls this per tenant.
 */
export async function releaseAbandonedCharges(
  repo: Pick<BudgetRepository, 'releaseAbandonedCharges'>,
  context: TenantContext,
  command: ReleaseAbandonedChargesCommand,
): Promise<number> {
  const ttl = command.ttlMs ?? ABANDONED_CHARGE_TTL_MS;
  if (ttl < ABANDONED_CHARGE_TTL_MS) {
    throw new RangeError(
      `ttlMs ${ttl} is shorter than the declared ABANDONED_CHARGE_TTL_MS (${ABANDONED_CHARGE_TTL_MS})`,
    );
  }
  return repo.releaseAbandonedCharges(
    scope(context, { olderThan: new Date(command.now.getTime() - ttl) }),
  );
}
