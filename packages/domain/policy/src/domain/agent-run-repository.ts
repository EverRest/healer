import { HealerError, type TenantScoped } from '@healer/shared';

/**
 * The writer for `agent_run` rows that a runner reported (012 T094, FR-033, FR-046a, ADR 0010). It
 * lives beside the budget reader of the same table so there is one definition of what a cost row
 * is. Cost is recorded **as reported**, with `cost_provenance = 'reported'`: nothing here, and
 * nothing anywhere yet, reconciles it against provider usage (no provider usage source exists), so
 * no code path may label it `measured` — the enum has no such member to write.
 */

/** A report names something that does not exist for this tenant (or, for a prompt version, at all).
 *  422, not 404: the *runner* exists, the thing it referenced does not. */
export class AgentRunReferenceNotFoundError extends HealerError {
  constructor(readonly reference: 'prompt_version' | 'issue' | 'policy_decision') {
    super('VALIDATION', `the report references a ${reference} that does not exist`);
    this.name = 'AgentRunReferenceNotFoundError';
  }
}

/** The same `reportId` arrived with different content. A redelivery is identical by construction,
 *  so this is a runner bug or a forgery; the first write stands and nothing is overwritten. */
export class AgentRunReportConflictError extends HealerError {
  constructor() {
    super('CONFLICT', 'a report with this reportId was already recorded with different content');
    this.name = 'AgentRunReportConflictError';
  }
}

export interface AgentRunReportRecord {
  /** Idempotency key: `(tenantId, reportId)` is unique in the database. */
  readonly reportId: string;
  /** Lookup key into THIS tenant's `runner_registration` rows; never an identity by itself. */
  readonly runnerName: string;
  readonly correlationId: string;
  readonly issueId?: string;
  readonly policyDecisionId?: string;
  /** Strings here, cast to the database enums in infrastructure: the one authority for each list is
   *  the Prisma enum, and `agent-run-closed-lists.test.ts` pins the envelope that feeds it. */
  readonly agentKind: string;
  readonly modelId: string;
  readonly provider: string;
  readonly promptVersionId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Decimal string at the column's scale — see `toCostDecimal`. */
  readonly cost: string;
  readonly toolCalls: readonly { name: string; argumentDigest: string; outcome: string }[];
  readonly outcome: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
}

export interface AgentRunRepository {
  /** The database clock — what the reported instants are bounded against. */
  databaseNow(): Promise<Date>;
  /**
   * Writes the row, or returns the one already written for `(tenantId, reportId)`. Throws
   * `NotFoundError('runner')` when `runnerName` is not registered under the tenant (a runner of
   * another tenant is indistinguishable from none), `AgentRunReferenceNotFoundError` for a prompt
   * version, issue or policy decision that does not resolve or may not be landed by this report (not
   * the tenant's, not an `allow`, invalidated, bound to another issue or workflow run, or already
   * landed by a finished run — all the same message, so existence does not leak), and
   * `AgentRunReportConflictError` when the id was reused with different content.
   */
  record(input: TenantScoped<AgentRunReportRecord>): Promise<{ id: string; created: boolean }>;
}
