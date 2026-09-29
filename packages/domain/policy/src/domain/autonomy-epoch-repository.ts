import type { TenantScoped } from '@healer/shared';

/**
 * `autonomy_epoch` (data-model.md `policy.autonomy_epoch`) — one row per tenant, bumped by every
 * grant revocation (R-07). `GrantAutonomy`/`RevokeAutonomy` are Phase 4, out of scope for this
 * batch, so no row is ever written yet: `current()` reads whatever exists and treats an absent
 * row as epoch `0` — the tenant has never had a revocation, which is indistinguishable from "the
 * revocation mechanism itself doesn't exist yet" until Phase 4 lands (see `EvaluateAndBind`'s own
 * doc comment for why this reading is not persisted onto `policy_decision` in this batch).
 */
export interface AutonomyEpochRepository {
  current(where: TenantScoped<object>): Promise<bigint>;
}
