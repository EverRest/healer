import { randomUUID } from 'node:crypto';
import { HealerError, NotFoundError, scope, type TenantContext } from '@healer/shared';
import type {
  ApprovalLifecycleRepository,
  ApprovalRequest,
} from '../../domain/approval-request-repository.js';
import { assertRequestable } from '../../domain/approval-lifecycle.js';
import { buildApprovalSummary } from '../../domain/approval-summary.js';
import type { PolicyDecisionRepository } from '../../domain/policy-decision-repository.js';

export const REQUEST_APPROVAL_AUDIT_ACTION = 'policy.request_approval';

export interface RequestApprovalInput {
  /** The persisted `require_approval` decision this request is issued for. */
  readonly decisionId: string;
  /** 001 evidence the approver is pointed at — identifiers only, never excerpts (T071). */
  readonly evidenceIds: readonly string[];
  /** The tenant's epoch when the decision was made — `evaluateAndBind`'s `autonomyEpoch`. Recorded
   *  on the request; refused if it is no longer current (a revocation happened in between). */
  readonly autonomyEpoch: bigint;
  /** The expiry asked for; projected onto the run's deadline, never later than it (T073). */
  readonly expiresAt?: Date;
}

/**
 * `RequestApproval` (T070, FR-015, quickstart 17). Reads the *stored* decision — it never accepts
 * a summary from its caller — builds the summary from it (`buildApprovalSummary`: identifiers and
 * structured fields only, T071), and hands the repository one transaction that parks the run on
 * 012's `approval` callback, projects the expiry onto the run's deadline and records the epoch.
 * A decision that is not bound to a run has nothing to park, so it is refused here rather than
 * producing a request nothing can ever resume.
 */
export async function requestApproval(
  repos: {
    readonly approvals: ApprovalLifecycleRepository;
    readonly decisions: PolicyDecisionRepository;
  },
  context: TenantContext,
  input: RequestApprovalInput,
  now: () => Date = () => new Date(),
): Promise<ApprovalRequest> {
  // The approver "sees the evidence, not a narrative" (data-model.md): a request with none is
  // refused rather than shown as an assertion with nothing behind it.
  if (input.evidenceIds.length === 0) {
    throw new HealerError('VALIDATION', 'approval refused: no evidence identifiers to show');
  }
  const decision = await repos.decisions.findById(scope(context, { id: input.decisionId }));
  if (decision === null) throw new NotFoundError('PolicyDecision');
  assertRequestable(decision);
  if (decision.workflowRunId === undefined) {
    throw new HealerError(
      'PRECONDITION_FAILED',
      `policy decision ${decision.id} is not bound to a workflow run, so there is nothing to park`,
    );
  }
  const summary = buildApprovalSummary(decision);
  const id = randomUUID();

  return repos.approvals.request(
    scope(context, {
      id,
      decisionId: decision.id,
      workflowRunId: decision.workflowRunId,
      summary,
      evidenceIds: input.evidenceIds,
      autonomyEpoch: input.autonomyEpoch,
      ...(input.expiresAt !== undefined ? { requestedExpiresAt: input.expiresAt } : {}),
      now: now(),
      auditEntry: scope(context, {
        id: randomUUID(),
        actorType: 'system' as const,
        actorRef: 'policy-engine',
        action: REQUEST_APPROVAL_AUDIT_ACTION,
        targetType: 'approval_request',
        targetId: id,
        reason: `approval requested for decision ${decision.id} under ruleset version ${decision.rulesetVersion}`,
        evidenceIds: input.evidenceIds,
        policyDecisionId: decision.id,
        outcome: 'ok',
      }),
    }),
  );
}
