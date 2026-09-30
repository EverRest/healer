import { currentCorrelationId, NotFoundError, type TenantScoped } from '@healer/shared';
import { Prisma, type PrismaClient } from '@healer/prisma-client';
import { enqueue, PrismaOutboxTransaction } from '@healer/events';
import { policyDecisionRecordedEvent } from '../domain/events.js';
import { decisionInputSchema, type DecisionInput } from '../domain/decision-input.js';
import type { BudgetState } from '../domain/evaluate.js';
import type { Outcome } from '../domain/outcome-lattice.js';
import {
  DecisionAlreadyConsumedError,
  DecisionNotAllowedError,
  DigestMismatchError,
  type ConsumeDecisionInput,
  type DecisionListFilter,
  type NewRecordedDecision,
  type PolicyDecisionRepository,
  type RecordedDecision,
  type StoredDecision,
} from '../domain/policy-decision-repository.js';
import type { ReasonCode } from '../domain/reason-code.js';

/** `record` publishes `PolicyDecisionRecorded` — a missing correlation scope is a caller error,
 *  the same rule every other outbox-publishing write in this package follows. */
function assertCorrelated(): void {
  if (currentCorrelationId() === undefined) {
    throw new Error(
      'EvaluateAndBind publishes PolicyDecisionRecorded: call it inside a correlated scope (withCorrelation)',
    );
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

/** Every column `findById`/`list` read back (data-model.md `policy.policy_decision`) — a
 *  superset of `DecisionRow`, which is only what `record()` needs to return. */
interface StoredDecisionRow extends DecisionRow {
  readonly issueId: string | null;
  readonly workflowRunId: string | null;
  readonly workflowState: string | null;
  readonly actionKey: string;
  readonly targetRef: string | null;
  readonly fingerprint: string | null;
  readonly decisionInput: unknown;
  readonly budgetState: unknown;
  readonly consumedAt: Date | null;
  readonly invalidatedReason: string | null;
}

/** Batch 9 C2 parses `decision_input` through `decisionInputSchema` instead of a raw cast; batch 9
 *  follow-up review (both independent Opus reviews) flagged that a bare `.parse()` throws a
 *  generic `ZodError` with no decision id in it — a single non-conforming stored row (increasingly
 *  likely once Phase 4+ adds fields to `DecisionInput`) turns `GET /policy/decisions` into a 500
 *  with no way to tell which row is bad. Wraps and rethrows with the id included, so a caller (or
 *  whoever reads the log) at least knows which row to look at. */
function parseStoredDecisionInput(row: { readonly id: string; readonly decisionInput: unknown }): DecisionInput {
  try {
    return decisionInputSchema.parse(row.decisionInput);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`policy_decision ${row.id}: stored decision_input failed schema validation — ${message}`);
  }
}

function toStoredDomain(row: StoredDecisionRow): StoredDecision {
  return {
    ...toDomain(row),
    actionKey: row.actionKey,
    ...(row.issueId !== null ? { issueId: row.issueId } : {}),
    ...(row.workflowRunId !== null ? { workflowRunId: row.workflowRunId } : {}),
    ...(row.workflowState !== null ? { workflowState: row.workflowState } : {}),
    ...(row.targetRef !== null ? { targetRef: row.targetRef } : {}),
    ...(row.fingerprint !== null ? { fingerprint: row.fingerprint } : {}),
    decisionInput: parseStoredDecisionInput(row),
    budgetState: row.budgetState as unknown as BudgetState,
    ...(row.consumedAt !== null ? { consumedAt: row.consumedAt } : {}),
    ...(row.invalidatedReason !== null ? { invalidatedReason: row.invalidatedReason } : {}),
  };
}

/** Raw `FOR UPDATE` row shape (real column names) for the lock `consume()` takes before deciding
 *  which refusal applies — the same pattern `prisma-issue-merge.ts`'s `lockIssues` already uses
 *  to serialise concurrent writers against one row. `outcome`/`invalidated_reason` added batch 9
 *  C1(a): the lock must cover every column the refusal decision reads, not only the two the
 *  original single-use check used. */
interface LockedDecisionRow {
  readonly consumed_at: Date | null;
  readonly proposal_digest: string;
  readonly outcome: string;
  readonly invalidated_reason: string | null;
}

/**
 * `PolicyDecisionRepository` (T021/T023, data-model.md `policy.policy_decision`). `record` writes
 * the decision and publishes `PolicyDecisionRecorded` through the outbox in one transaction — no
 * audit entry: quickstart 37's four audited config changes are publish/grant/revoke/budget, not
 * every decision (contracts/evaluation.md's own event table lists no audit obligation here).
 * `consume` locks the row before checking, so two concurrent executions against the same decision
 * can never both see `consumed_at IS NULL` — and (batch 9 C1(a)) refuses a decision that never
 * resolved to `allow` or that has since been invalidated, before `consumed_at` is ever set.
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
        SELECT consumed_at, proposal_digest, outcome, invalidated_reason
        FROM "policy"."policy_decision"
        WHERE tenant_id = ${tenantId}::uuid AND id = ${decisionId}::uuid
        FOR UPDATE`;
      const row = rows[0];
      if (row === undefined) throw new NotFoundError('PolicyDecision');
      if (row.consumed_at !== null) throw new DecisionAlreadyConsumedError(decisionId);
      if (row.invalidated_reason !== null) {
        throw new DecisionNotAllowedError(decisionId, 'invalidated');
      }
      if (row.outcome !== 'allow') throw new DecisionNotAllowedError(decisionId, 'outcome');
      if (row.proposal_digest !== presentedDigest) throw new DigestMismatchError(decisionId);
      await tx.policyDecision.update({
        where: { id: decisionId },
        data: { consumedAt: new Date() },
      });
    });
  }

  async findById(where: TenantScoped<{ id: string }>): Promise<StoredDecision | null> {
    try {
      const row = await this.prisma.policyDecision.findUnique({
        where: { id_tenantId: { id: where.id, tenantId: where.tenantId } },
      });
      return row === null ? null : toStoredDomain(row as unknown as StoredDecisionRow);
    } catch (error) {
      // A malformed (non-UUID) id fails Postgres's own column cast (P2023) before the query ever
      // runs — indistinguishable from "does not exist" for a caller (same precedent as
      // `prisma-issue-repository.ts`'s `findById`, SC-004).
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2023') {
        return null;
      }
      throw error;
    }
  }

  async list(where: TenantScoped<DecisionListFilter>): Promise<readonly StoredDecision[]> {
    const rows = await this.prisma.policyDecision.findMany({
      where: {
        tenantId: where.tenantId,
        ...(where.issueId !== undefined ? { issueId: where.issueId } : {}),
        ...(where.actionKey !== undefined ? { actionKey: where.actionKey } : {}),
        ...(where.outcome !== undefined ? { outcome: where.outcome } : {}),
        ...(where.since !== undefined ? { evaluatedAt: { gte: where.since } } : {}),
      },
      orderBy: { evaluatedAt: 'desc' },
    });
    return rows.map((row) => toStoredDomain(row as unknown as StoredDecisionRow));
  }
}
