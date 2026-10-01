import { randomUUID } from 'node:crypto';
import { scope, type TenantContext } from '@healer/shared';
import { ACTION_CEILING } from '../../domain/ceiling.js';
import {
  CeilingExceededError,
  type AutonomyGrant,
  type AutonomyGrantRepository,
} from '../../domain/autonomy-grant-repository.js';
import type { PolicyActionRepository } from '../../domain/policy-action-repository.js';
import { UnregisteredActionError } from '../resolve-ruleset-and-evaluate.js';

/** The audit `action` a grant records — registered in `SEED_POLICY_ACTIONS` with
 *  `mutating: false` (batch 9 I1's own fix applied up front this time, not after
 *  `check:policy-coverage` finds it): a grant is an admin/config change, never itself a decision
 *  the ceiling gates. */
export const GRANT_AUTONOMY_AUDIT_ACTION = 'policy.grant_autonomy';

export interface GrantAutonomyInput {
  readonly componentId?: string;
  readonly environment?: string;
  readonly issueKind?: string;
  readonly actionKey: string;
  readonly level: number;
  readonly grantedBy: string;
}

/**
 * `GrantAutonomy` (T034, T037, T039, FR-007, FR-008, SC-004). Rejects a level the action's
 * class — or, for `reversible_remediation`, the absence of a tested undo — can never carry,
 * **before** the row is ever written (`CeilingExceededError`, `422 CEILING_EXCEEDED`).
 *
 * `hasTestedUndo` is passed as `false` unconditionally: 010's remediation catalogue, the only
 * source of an attestation, does not exist in this repository yet (same honest-`false` reading
 * `policy-evaluation.controller.ts`'s `GET /policy/actions` already gives, not a placeholder
 * standing in for a real lookup). Until it does, no `reversible_remediation` grant can pass this
 * check — matching the DB trigger's own conservative stance (T035) and C-18's requirement that
 * such a class earns no level at all while its undo is unattested.
 *
 * This is the first of R-05's two independent mechanisms — the DB check constraint (T035) is the
 * second, for a row written around this command entirely.
 */
export async function grantAutonomy(
  repos: { readonly grants: AutonomyGrantRepository; readonly actions: PolicyActionRepository },
  context: TenantContext,
  input: GrantAutonomyInput,
  now: () => Date = () => new Date(),
): Promise<AutonomyGrant> {
  const action = await repos.actions.findByKey(input.actionKey);
  if (action === null) throw new UnregisteredActionError(input.actionKey);

  const ceiling = ACTION_CEILING(action.actionClass, false);
  if (ceiling.kind === 'none' || input.level > ceiling.level) {
    throw new CeilingExceededError(input.actionKey, input.level, ceiling);
  }

  const id = randomUUID();
  return repos.grants.create(
    scope(context, {
      id,
      ...(input.componentId !== undefined ? { componentId: input.componentId } : {}),
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
      ...(input.issueKind !== undefined ? { issueKind: input.issueKind } : {}),
      actionKey: input.actionKey,
      level: input.level,
      grantedBy: input.grantedBy,
      grantedAt: now(),
      auditEntry: scope(context, {
        id: randomUUID(),
        actorType: 'human',
        actorRef: input.grantedBy,
        action: GRANT_AUTONOMY_AUDIT_ACTION,
        targetType: 'autonomy_grant',
        targetId: id,
        reason: `granted level ${input.level} for ${input.actionKey}`,
        evidenceIds: [],
        outcome: 'ok',
      }),
    }),
  );
}
