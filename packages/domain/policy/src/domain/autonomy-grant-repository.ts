import { HealerError, type TenantScoped } from '@healer/shared';
import type { Ceiling } from './ceiling.js';
import type { NewAuditEntry } from './audit-entry.js';

/** `policy.autonomy_grant` (data-model.md, T039). Optional scope fields are `undefined` for "all
 *  <thing>" — the same null-means-wildcard convention the table itself uses. */
export interface AutonomyGrant {
  readonly id: string;
  readonly componentId?: string;
  readonly environment?: string;
  readonly issueKind?: string;
  readonly actionKey: string;
  readonly level: number;
  readonly grantedBy: string;
  readonly grantedAt: Date;
  readonly revokedBy?: string;
  readonly revokedAt?: Date;
}

export interface NewAutonomyGrant {
  readonly id: string;
  readonly componentId?: string;
  readonly environment?: string;
  readonly issueKind?: string;
  readonly actionKey: string;
  readonly level: number;
  readonly grantedBy: string;
  readonly grantedAt: Date;
  readonly auditEntry: TenantScoped<NewAuditEntry>;
}

export interface RevokeAutonomyGrant {
  readonly id: string;
  readonly revokedBy: string;
  readonly revokedAt: Date;
  /** `autonomy_epoch.bump_reason` — every revocation bumps the tenant epoch in the same
   *  transaction (T043, R-07). */
  readonly bumpReason: string;
  readonly auditEntry: TenantScoped<NewAuditEntry>;
}

/** `POST /autonomy/grants` (T034, T037) requests a level the action's class — or, for
 *  `reversible_remediation`, the absence of a tested undo — can never carry (FR-008, SC-004).
 *  The DB check (T035) enforces this a second, independent way for a row written around this
 *  command entirely (R-05); this is the one a normal caller actually sees. */
export class CeilingExceededError extends HealerError {
  constructor(
    readonly actionKey: string,
    readonly requestedLevel: number,
    readonly ceiling: Ceiling,
  ) {
    super(
      'CEILING_EXCEEDED',
      ceiling.kind === 'none'
        ? `action "${actionKey}" has no grantable autonomy level for its class`
        : `level ${requestedLevel} for action "${actionKey}" exceeds its ceiling of ${ceiling.level}`,
    );
    this.name = 'CeilingExceededError';
  }
}

/** `revoke()` on a grant that is already revoked (data-model.md: "terminal; a revoked grant is
 *  never reactivated"). */
export class GrantAlreadyRevokedError extends HealerError {
  constructor(readonly grantId: string) {
    super('CONFLICT', `autonomy grant ${grantId} has already been revoked`);
    this.name = 'GrantAlreadyRevokedError';
  }
}

/** Read side only — the resolution query `resolveRulesetAndEvaluate` needs to correct
 *  `DecisionInput.autonomy.level` from real grants (T039, same shape as
 *  `ReadOnlyPolicyRulesetRepository`). */
export interface ReadOnlyAutonomyGrantRepository {
  /** Every non-revoked grant for this tenant and action key — narrow enough that resolution
   *  never has to guess which of the tenant's grants might apply; `resolveAutonomyLevel` narrows
   *  further by component/environment/issue kind. */
  findActive(
    where: TenantScoped<{ readonly actionKey: string }>,
  ): Promise<readonly AutonomyGrant[]>;
}

/** `policy.autonomy_grant`, read and write (T039). `GrantAutonomy`/`RevokeAutonomy` depend on
 *  this; evaluation only ever needs `ReadOnlyAutonomyGrantRepository` above. */
export interface AutonomyGrantRepository extends ReadOnlyAutonomyGrantRepository {
  findById(where: TenantScoped<{ readonly id: string }>): Promise<AutonomyGrant | null>;

  list(where: TenantScoped<object>): Promise<readonly AutonomyGrant[]>;

  /** Writes the grant and its audit entry in one transaction, and publishes `AutonomyGranted`
   *  through the outbox. The DB's own check constraint (T035) is the second, independent
   *  ceiling enforcement — this can still throw a raw constraint violation if some future caller
   *  bypasses `grantAutonomy`'s own check (`CeilingExceededError`), which is by design (R-05). */
  create(where: TenantScoped<NewAutonomyGrant>): Promise<AutonomyGrant>;

  /** Sets `revoked_by`/`revoked_at` (terminal — never reactivated) and bumps the tenant's
   *  `autonomy_epoch` in the same transaction (T043, R-07), writes the audit entry, and
   *  publishes `AutonomyRevoked`. Throws `NotFoundError` for a grant id that does not resolve
   *  under this tenant, or one already revoked. */
  revoke(where: TenantScoped<RevokeAutonomyGrant>): Promise<AutonomyGrant>;
}
