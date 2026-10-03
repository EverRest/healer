import { randomUUID } from 'node:crypto';
import { NotFoundError, scope, type TenantContext } from '@healer/shared';
import { assertRedeemable } from '../../domain/approval-lifecycle.js';
import type {
  ApprovalLifecycleRepository,
  ApprovalRequest,
} from '../../domain/approval-request-repository.js';

export const RESOLVE_APPROVAL_AUDIT_ACTION = 'policy.resolve_approval';

export interface ResolveApprovalInput {
  readonly approvalId: string;
  readonly resolution: 'approved' | 'rejected';
  /** The authenticated human — from the auth context, never the request body. */
  readonly resolvedBy: string;
  readonly note?: string;
}

/**
 * `ResolveApproval` (T074, FR-017, quickstart 17). The human's click is the *redemption* of the
 * request, so this is where `STALE_AUTONOMY_EPOCH` (T044, R-07) is enforced: `assertRedeemable`
 * runs inside the repository's transaction, under the row lock, against the epoch read there —
 * so it holds with the revocation sweep disabled, and a concurrent `ExpireApproval` cannot also
 * win. The audit entry names the human and the ruleset version the decision was made under
 * (US5 scenario 3); that version is read from the immutable decision, not from "whatever is
 * published now".
 */
export async function resolveApproval(
  repos: { readonly approvals: ApprovalLifecycleRepository },
  context: TenantContext,
  input: ResolveApprovalInput,
  now: () => Date = () => new Date(),
): Promise<ApprovalRequest> {
  const existing = await repos.approvals.findById(scope(context, { id: input.approvalId }));
  if (existing === null) throw new NotFoundError('approval_request');

  const note = input.note === undefined || input.note === '' ? '' : `: ${input.note}`;
  return repos.approvals.resolve(
    scope(context, {
      id: input.approvalId,
      resolution: input.resolution,
      resolvedBy: input.resolvedBy,
      resolvedAt: now(),
      assertRedeemable,
      auditEntry: scope(context, {
        id: randomUUID(),
        actorType: 'human' as const,
        actorRef: input.resolvedBy,
        action: RESOLVE_APPROVAL_AUDIT_ACTION,
        targetType: 'approval_request',
        targetId: input.approvalId,
        reason: `${input.resolution} by ${input.resolvedBy} under ruleset version ${existing.rulesetVersion}${note}`,
        evidenceIds: existing.evidenceIds,
        policyDecisionId: existing.decisionId,
        outcome: 'ok',
      }),
    }),
  );
}
