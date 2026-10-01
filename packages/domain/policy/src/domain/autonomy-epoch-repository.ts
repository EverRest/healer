import type { TenantScoped } from '@healer/shared';

/**
 * `autonomy_epoch` (data-model.md `policy.autonomy_epoch`) — one row per tenant, bumped by every
 * grant revocation (R-07). `current()` reads whatever exists and treats an absent row as epoch
 * `0` — the tenant has never had a revocation.
 */
export interface AutonomyEpochRepository {
  current(where: TenantScoped<object>): Promise<bigint>;

  /** T043: increments the epoch (starting from 0 when no row exists yet) and returns the new
   *  value. `RevokeAutonomy`'s own repository call bumps the epoch in the *same* transaction as
   *  the grant revocation it accompanies rather than calling this method separately — this exists
   *  so the bump is independently callable and testable (T044) without a grant in play. */
  bump(
    where: TenantScoped<{ readonly bumpedBy: string; readonly bumpReason: string }>,
  ): Promise<bigint>;
}
