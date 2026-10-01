import type { AutonomyGrant } from './autonomy-grant-repository.js';

/** The proposal fields a grant's scope is matched against (data-model.md `autonomy_grant`:
 *  `(tenant, component, environment, issue kind, action)`). `tenantId` is not here — callers
 *  already read `grants` from a `TenantScoped` repository call, so every grant passed in is
 *  already this tenant's. */
export interface AutonomyGrantTarget {
  readonly actionKey: string;
  readonly componentId: string;
  readonly environment: string;
  readonly issueKind: string;
}

/** T039: resolves the autonomy level a proposal actually has — the level `evaluate()`'s
 *  `input.autonomy.level` must carry, replacing whatever a caller claimed (same "the registry
 *  decides, not the caller" move batch 9 made for `action.actionClass`, `resolve-ruleset-and-
 *  evaluate.ts`).
 *
 * A grant matches when its `actionKey` matches and each of `componentId`/`environment`/
 * `issueKind` is either null (wildcard) or equal to the target's. The resolved level is the max
 * over every matching, non-revoked grant, or 0 when none match (data-model.md: "grants are
 * additive and the ceiling clamps the maximum, so overlapping grants cannot raise a level above
 * what either grants alone" — additive means max, not sum: two L1 grants never make L2).
 */
export function resolveAutonomyLevel(
  grants: readonly AutonomyGrant[],
  target: AutonomyGrantTarget,
): number {
  let level = 0;
  for (const grant of grants) {
    if (grant.revokedAt !== undefined) continue;
    if (grant.actionKey !== target.actionKey) continue;
    if (grant.componentId !== undefined && grant.componentId !== target.componentId) continue;
    if (grant.environment !== undefined && grant.environment !== target.environment) continue;
    if (grant.issueKind !== undefined && grant.issueKind !== target.issueKind) continue;
    if (grant.level > level) level = grant.level;
  }
  return level;
}
