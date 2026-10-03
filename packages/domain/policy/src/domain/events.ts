import { currentCorrelationId } from '@healer/shared';
import type { DomainEvent } from '@healer/events';

/**
 * Outbox publishers for `contracts/evaluation.md`'s "Events published through the outbox" table
 * (T016, 012 FR-031). No caller exists yet: `EvaluateAndBind`, `GrantAutonomy`, `PublishRuleset`
 * and friends land in later phases (T019, T021, T039, T045, ...). A future command writes its
 * state change and one of these events inside the *same* transaction, exactly the way
 * `packages/domain/issues/src/infrastructure/prisma-issue-repository.ts` already does:
 *
 * ```ts
 * await enqueue(new PrismaOutboxTransaction(tx), policyDecisionRecordedEvent(...));
 * ```
 *
 * `subjectId` is the aggregate the event is about (the decision, the approval, the grant, the
 * ruleset) and is not repeated inside `payload` — the same convention
 * `packages/domain/issues/src/domain/events.ts` already established for `IssueDetected` et al.
 */

/** Requires an active correlation scope, same rule as issues' `events.ts` (a missing scope is a
 * caller error, never papered over with a freshly minted id — that would read as a second
 * investigation). */
function requireCorrelationId(): string {
  const id = currentCorrelationId();
  if (id === undefined) {
    throw new Error('cannot publish a domain event outside a correlated scope (withCorrelation)');
  }
  return id;
}

export function policyDecisionRecordedEvent(
  tenantId: string,
  decision: {
    readonly decisionId: string;
    readonly actionKey: string;
    readonly outcome: string;
    readonly rulesetVersion: number;
    readonly reasonCodes: readonly string[];
    readonly issueId?: string;
  },
): DomainEvent {
  return {
    name: 'PolicyDecisionRecorded',
    tenantId,
    subjectId: decision.decisionId,
    correlationId: requireCorrelationId(),
    payload: {
      actionKey: decision.actionKey,
      outcome: decision.outcome,
      rulesetVersion: decision.rulesetVersion,
      reasonCodes: [...decision.reasonCodes],
      ...(decision.issueId !== undefined ? { issueId: decision.issueId } : {}),
    },
  };
}

export function approvalRequestedEvent(
  tenantId: string,
  approval: {
    readonly approvalId: string;
    readonly summary: Readonly<Record<string, unknown>>;
    readonly expiresAt: Date;
  },
): DomainEvent {
  return {
    name: 'ApprovalRequested',
    tenantId,
    subjectId: approval.approvalId,
    correlationId: requireCorrelationId(),
    payload: { summary: approval.summary, expiresAt: approval.expiresAt.toISOString() },
  };
}

export function approvalResolvedEvent(
  tenantId: string,
  approval: {
    readonly approvalId: string;
    readonly resolution: 'approved' | 'rejected';
    readonly resolvedBy: string;
  },
): DomainEvent {
  return {
    name: 'ApprovalResolved',
    tenantId,
    subjectId: approval.approvalId,
    correlationId: requireCorrelationId(),
    payload: { resolution: approval.resolution, resolvedBy: approval.resolvedBy },
  };
}

export function approvalExpiredEvent(
  tenantId: string,
  approval: { readonly approvalId: string; readonly workflowRunId: string },
): DomainEvent {
  return {
    name: 'ApprovalExpired',
    tenantId,
    subjectId: approval.approvalId,
    correlationId: requireCorrelationId(),
    payload: { workflowRunId: approval.workflowRunId },
  };
}

/** The scope a grant/revoke applies to (data-model.md `autonomy_grant`). */
export interface AutonomyGrantScope {
  readonly grantId: string;
  readonly componentId?: string;
  readonly environment?: string;
  readonly issueKind?: string;
}

function scopePayload(scope: AutonomyGrantScope): Record<string, unknown> {
  return {
    ...(scope.componentId !== undefined ? { componentId: scope.componentId } : {}),
    ...(scope.environment !== undefined ? { environment: scope.environment } : {}),
    ...(scope.issueKind !== undefined ? { issueKind: scope.issueKind } : {}),
  };
}

export function autonomyGrantedEvent(
  tenantId: string,
  grant: {
    readonly scope: AutonomyGrantScope;
    readonly actionKey: string;
    readonly level: number;
    readonly epoch: bigint;
  },
): DomainEvent {
  return {
    name: 'AutonomyGranted',
    tenantId,
    subjectId: grant.scope.grantId,
    correlationId: requireCorrelationId(),
    payload: {
      scope: scopePayload(grant.scope),
      actionKey: grant.actionKey,
      level: grant.level,
      epoch: grant.epoch.toString(),
    },
  };
}

export function autonomyRevokedEvent(
  tenantId: string,
  grant: {
    readonly scope: AutonomyGrantScope;
    readonly actionKey: string;
    readonly level: number;
    readonly epoch: bigint;
  },
): DomainEvent {
  return {
    name: 'AutonomyRevoked',
    tenantId,
    subjectId: grant.scope.grantId,
    correlationId: requireCorrelationId(),
    payload: {
      scope: scopePayload(grant.scope),
      actionKey: grant.actionKey,
      level: grant.level,
      epoch: grant.epoch.toString(),
    },
  };
}

/** The budget scope a degradation/exhaustion applies to (data-model.md `budget_limit`). */
export interface BudgetScope {
  readonly scopeType: 'issue' | 'tenant';
  readonly scopeId: string;
}

export function budgetDegradedEvent(
  tenantId: string,
  budget: {
    readonly scope: BudgetScope;
    readonly periodKey: string;
    readonly step: number;
    /** The entry of the declared degradation order — a closed-list key (`DEGRADATION_ORDER`),
     *  never prose. */
    readonly entryApplied: string;
    readonly evidenceId: string;
  },
): DomainEvent {
  return {
    name: 'BudgetDegraded',
    tenantId,
    subjectId: budget.scope.scopeId,
    correlationId: requireCorrelationId(),
    payload: {
      scopeType: budget.scope.scopeType,
      periodKey: budget.periodKey,
      step: budget.step,
      entryApplied: budget.entryApplied,
      // The evidenceId, not the degradation text — a consumer reads the evidence substrate
      // rather than a copy of it (contracts/evaluation.md).
      evidenceId: budget.evidenceId,
    },
  };
}

export function budgetExhaustedEvent(
  tenantId: string,
  budget: {
    readonly scope: BudgetScope;
    readonly periodKey: string;
    readonly consumed: number;
    readonly limit: number;
  },
): DomainEvent {
  return {
    name: 'BudgetExhausted',
    tenantId,
    subjectId: budget.scope.scopeId,
    correlationId: requireCorrelationId(),
    payload: {
      scopeType: budget.scope.scopeType,
      periodKey: budget.periodKey,
      consumed: budget.consumed,
      limit: budget.limit,
    },
  };
}

export function policyRulesetPublishedEvent(
  tenantId: string,
  ruleset: {
    readonly rulesetId: string;
    readonly version: number;
    readonly digest: string;
    readonly supersedesVersion?: number;
  },
): DomainEvent {
  return {
    name: 'PolicyRulesetPublished',
    tenantId,
    subjectId: ruleset.rulesetId,
    correlationId: requireCorrelationId(),
    payload: {
      version: ruleset.version,
      digest: ruleset.digest,
      ...(ruleset.supersedesVersion !== undefined
        ? { supersedesVersion: ruleset.supersedesVersion }
        : {}),
    },
  };
}
