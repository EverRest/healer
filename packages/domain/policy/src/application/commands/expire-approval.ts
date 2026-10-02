import { randomUUID } from 'node:crypto';
import { NotFoundError, scope, type TenantContext } from '@healer/shared';
import { assertDue, buildLapseDecision } from '../../domain/approval-lifecycle.js';
import {
  ApprovalNotPendingError,
  type ApprovalLifecycleRepository,
  type ApprovalRequest,
} from '../../domain/approval-request-repository.js';
import type { PolicyDecisionRepository } from '../../domain/policy-decision-repository.js';

export const EXPIRE_APPROVAL_AUDIT_ACTION = 'policy.expire_approval';

interface Repos {
  readonly approvals: ApprovalLifecycleRepository;
  readonly decisions: PolicyDecisionRepository;
}

/**
 * `ExpireApproval` (T072/T073, FR-016, SC-007, R-09), run from the `workflow_run.deadline_at`
 * tick. A lapse stops the workflow and never permits anything: the request becomes `expired`, a
 * `DENY` decision with reason `APPROVAL_EXPIRED` is recorded, the run goes to `needs_human`.
 * There is no delegation and no second approver — no code path here names one.
 *
 * The original decision is read before the transaction (it is immutable); the *state* guard
 * (`assertDue`) runs inside it under the row lock, so a `ResolveApproval` racing this tick leaves
 * exactly one winner.
 */
export async function expireApproval(
  repos: Repos,
  context: TenantContext,
  input: { readonly approvalId: string },
  now: () => Date = () => new Date(),
): Promise<ApprovalRequest> {
  const approval = await repos.approvals.findById(scope(context, { id: input.approvalId }));
  if (approval === null) throw new NotFoundError('approval_request');
  const original = await repos.decisions.findById(scope(context, { id: approval.decisionId }));
  if (original === null) throw new NotFoundError('PolicyDecision');

  const at = now();
  const lapse = buildLapseDecision(original, randomUUID(), at);
  return repos.approvals.expire(
    scope(context, {
      id: input.approvalId,
      now: at,
      assertDue,
      lapseDecision: scope(context, lapse),
      auditEntry: scope(context, {
        id: randomUUID(),
        actorType: 'system' as const,
        actorRef: 'deadline-tick',
        action: EXPIRE_APPROVAL_AUDIT_ACTION,
        targetType: 'approval_request',
        targetId: input.approvalId,
        reason: `approval lapsed under ruleset version ${approval.rulesetVersion}; run moved to needs_human`,
        evidenceIds: approval.evidenceIds,
        policyDecisionId: lapse.id,
        outcome: 'ok',
      }),
    }),
  );
}

export interface ExpireDueApprovalsResult {
  readonly expired: readonly ApprovalRequest[];
  /** Resolved (or expired by another tick) between the read and the write — the lock working. */
  readonly skipped: number;
}

/** The tick body for one tenant: expires every pending request whose time has come. One failing
 *  request never blocks the rest; failures are raised together at the end (a retry is safe, since
 *  `expire` is a no-op on anything no longer pending). */
export async function expireDueApprovals(
  repos: Repos,
  context: TenantContext,
  now: () => Date = () => new Date(),
): Promise<ExpireDueApprovalsResult> {
  const at = now();
  const due = await repos.approvals.findDue(scope(context, { now: at }));
  const expired: ApprovalRequest[] = [];
  const failures: unknown[] = [];
  let skipped = 0;
  for (const approval of due) {
    try {
      expired.push(await expireApproval(repos, context, { approvalId: approval.id }, () => at));
    } catch (error) {
      if (error instanceof ApprovalNotPendingError || error instanceof NotFoundError) skipped += 1;
      else failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `approval expiry tick: ${failures.length} of ${due.length} failed (${expired.length} expired, ${skipped} skipped)`,
    );
  }
  return { expired, skipped };
}
