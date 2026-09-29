import { currentCorrelationId, NotFoundError, type TenantScoped } from '@healer/shared';
import { Prisma, type PrismaClient } from '@healer/prisma-client';
import { enqueue, PrismaOutboxTransaction } from '@healer/events';
import { policyDecisionRecordedEvent } from '../domain/events.js';
import type { Outcome } from '../domain/outcome-lattice.js';
import {
  DecisionAlreadyConsumedError,
  DigestMismatchError,
  type ConsumeDecisionInput,
  type NewRecordedDecision,
  type PolicyDecisionRepository,
  type RecordedDecision,
} from '../domain/policy-decision-repository.js';
import type { ReasonCode } from '../domain/reason-code.js';

/** `record` publishes `PolicyDecisionRecorded` — a missing correlation scope is a caller error,
 *  the same rule every other outbox-publishing write in this package follows. */
function assertCorrelated(): void {
  if (currentCorrelationId() === undefined) {
    throw new Error('EvaluateAndBind publishes PolicyDecisionRecorded: call it inside a correlated scope (withCorrelation)');
  }
}

interface DecisionRow {
  readonly id: string;
  readonly proposalDigest: string;
  readonly outcome: string;
  readonly reasonCodes: readonly string[];
  readonly rulesetVersion: number;
  readonly matchedRuleKeys: readonly string[];
  readonly ceilingApplied: boolean;
  readonly evaluatedAt: Date;
}

function toDomain(row: DecisionRow): RecordedDecision {
  return {
    id: row.id,
    proposalDigest: row.proposalDigest,
    outcome: row.outcome as Outcome,
    reasonCodes: row.reasonCodes as readonly ReasonCode[],
    rulesetVersion: row.rulesetVersion,
    matchedRuleKeys: row.matchedRuleKeys,
    ceilingApplied: row.ceilingApplied,
    evaluatedAt: row.evaluatedAt,
  };
}

/** Raw `FOR UPDATE` row shape (real column names) for the lock `consume()` takes before deciding
 *  which of the two refusals applies — the same pattern `prisma-issue-merge.ts`'s `lockIssues`
 *  already uses to serialise concurrent writers against one row. */
interface LockedDecisionRow {
  readonly consumed_at: Date | null;
  readonly proposal_digest: string;
}

/**
 * `PolicyDecisionRepository` (T021/T023, data-model.md `policy.policy_decision`). `record` writes
 * the decision and publishes `PolicyDecisionRecorded` through the outbox in one transaction — no
 * audit entry: quickstart 37's four audited config changes are publish/grant/revoke/budget, not
 * every decision (contracts/evaluation.md's own event table lists no audit obligation here).
 * `consume` locks the row before checking, so two concurrent executions against the same decision
 * can never both see `consumed_at IS NULL`.
 */
export class PrismaPolicyDecisionRepository implements PolicyDecisionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async record(where: TenantScoped<NewRecordedDecision>): Promise<RecordedDecision> {
    assertCorrelated();
    const { tenantId } = where;
    const event = policyDecisionRecordedEvent(tenantId, {
      decisionId: where.id,
      actionKey: where.actionKey,
      outcome: where.decision.outcome,
      rulesetVersion: where.decision.rulesetVersion,
      reasonCodes: where.decision.reasonCodes,
      ...(where.binding.issueId !== undefined ? { issueId: where.binding.issueId } : {}),
    });

    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.policyDecision.create({
        data: {
          id: where.id,
          tenantId,
          issueId: where.binding.issueId ?? null,
          workflowRunId: where.binding.workflowRunId ?? null,
          workflowState: where.binding.workflowState ?? null,
          actionKey: where.actionKey,
          targetRef: where.targetRef ?? null,
          fingerprint: where.fingerprint ?? null,
          proposalDigest: where.proposalDigest,
          decisionInput: where.decisionInput as unknown as Prisma.InputJsonValue,
          rulesetVersion: where.decision.rulesetVersion,
          matchedRuleKeys: [...where.decision.matchedRuleKeys],
          outcome: where.decision.outcome,
          reasonCodes: [...where.decision.reasonCodes],
          ceilingApplied: where.decision.ceilingApplied,
          budgetState: where.budgetState as unknown as Prisma.InputJsonValue,
          evaluatedAt: where.decision.evaluatedAt,
        },
      });
      await enqueue(new PrismaOutboxTransaction(tx), event);
      return created;
    });

    return toDomain(row);
  }

  async consume(where: TenantScoped<ConsumeDecisionInput>): Promise<void> {
    const { tenantId, decisionId, presentedDigest } = where;
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<LockedDecisionRow[]>`
        SELECT consumed_at, proposal_digest FROM "policy"."policy_decision"
        WHERE tenant_id = ${tenantId}::uuid AND id = ${decisionId}::uuid
        FOR UPDATE`;
      const row = rows[0];
      if (row === undefined) throw new NotFoundError('PolicyDecision');
      if (row.consumed_at !== null) throw new DecisionAlreadyConsumedError(decisionId);
      if (row.proposal_digest !== presentedDigest) throw new DigestMismatchError(decisionId);
      await tx.policyDecision.update({ where: { id: decisionId }, data: { consumedAt: new Date() } });
    });
  }
}
