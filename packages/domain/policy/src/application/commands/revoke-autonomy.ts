import { randomUUID } from 'node:crypto';
import { scope, type TenantContext } from '@healer/shared';
import type {
  AutonomyGrant,
  AutonomyGrantRepository,
} from '../../domain/autonomy-grant-repository.js';

export const REVOKE_AUTONOMY_AUDIT_ACTION = 'policy.revoke_autonomy';

export interface RevokeAutonomyInput {
  readonly grantId: string;
  readonly revokedBy: string;
  readonly reason?: string;
}

/**
 * `RevokeAutonomy` (T039, T043, FR-007, R-07). Delegates the atomic revoke-and-bump to the
 * repository (`AutonomyGrantRepository.revoke`, same transaction) — this command only shapes the
 * audit entry and the epoch's `bump_reason`. Throws `NotFoundError` for an unknown grant id and
 * `GrantAlreadyRevokedError` for one already revoked (both from the repository).
 *
 * The epoch bump is what T041/T044 lean on: nothing re-checks a grant directly, so revocation
 * reaches every future evaluation for this tenant only because the epoch it stamps every
 * outstanding approval with is now stale (contracts/evaluation.md).
 */
export async function revokeAutonomy(
  repos: { readonly grants: AutonomyGrantRepository },
  context: TenantContext,
  input: RevokeAutonomyInput,
  now: () => Date = () => new Date(),
): Promise<AutonomyGrant> {
  const reason = input.reason ?? `revoked by ${input.revokedBy}`;
  const revokedAt = now();
  return repos.grants.revoke(
    scope(context, {
      id: input.grantId,
      revokedBy: input.revokedBy,
      revokedAt,
      bumpReason: reason,
      auditEntry: scope(context, {
        id: randomUUID(),
        actorType: 'human',
        actorRef: input.revokedBy,
        action: REVOKE_AUTONOMY_AUDIT_ACTION,
        targetType: 'autonomy_grant',
        targetId: input.grantId,
        reason,
        evidenceIds: [],
        outcome: 'ok',
      }),
    }),
  );
}
