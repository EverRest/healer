import type { TenantScoped } from '@healer/shared';
import type { NewAuditEntry } from './audit-entry.js';
import type { BudgetPeriod } from './budget-bounds.js';
import type { ScopeFigures } from './budget-figures.js';
import type { NewRecordedDecision, RecordedDecision } from './policy-decision-repository.js';

// Ports for budget state (T056, T057, T060, T064; FR-011..FR-013, R-10..R-12). Nothing a
// repository returns here is a stored counter: consumption is **derived** on every call from
// `agent_run.cost` and `workflow_run` elapsed time, so the number policy enforces and the number
// support reports cannot disagree (R-10).

/** The `workflow_transition.to_state` that counts as one escalation attempt (FR-013). 012 owns
 *  the state graph and 006/008 define the workflows; this is the one name policy counts, declared
 *  once — a workflow whose escalation state is named differently is not counted, which is what
 *  `check:budget-reconcile` would surface as a run past its cap. */
export const ESCALATION_TO_STATE = 'escalating';

/** What one evaluation needs resolved. `asOf` is the caller's instant (the evaluator reads no
 *  clock); `workflowRunId` is what pins the period key to the run's start (T062). */
export interface BudgetQuery {
  readonly issueId?: string;
  readonly workflowRunId?: string;
  readonly asOf: Date;
}

export interface ResolvedBudget {
  /** Every budget that applies — the tenant's day and month, plus the issue's when one is named. */
  readonly scopes: readonly ScopeFigures[];
  /** FR-013: counted from the run's escalation transitions in 012's `workflow_transition`, never
   *  from a counter kept here; the cap is the tightest `escalation_attempt_cap` that applies. */
  readonly escalation: { readonly attemptCount: number; readonly cap: number };
  /** The declared degradation order for this tenant — members of `DEGRADATION_ORDER` only. */
  readonly degradationOrder: readonly string[];
}

export interface MarkDegradationInput {
  readonly scopeType: 'issue' | 'tenant';
  readonly scopeId: string;
  readonly periodKey: string;
  readonly step: number;
  readonly entryApplied: string;
  readonly consumed: number;
  readonly limit: number;
  readonly dimension: 'spend' | 'time';
  /** The issue the evidence record attaches to (evidence is per issue, 001). */
  readonly issueId: string;
  readonly observedAt: Date;
}

export interface MarkDegradationResult {
  /** False when the step had already been recorded — the idempotent re-delivery. */
  readonly marked: boolean;
  readonly evidenceId: string;
}

export interface ReadOnlyBudgetRepository {
  resolve(where: TenantScoped<BudgetQuery>): Promise<ResolvedBudget>;
}

export interface BudgetRepository extends ReadOnlyBudgetRepository {
  /**
   * The ex-ante charge (T060, R-11). Under a per-tenant serialization lock: resolve the budget,
   * run `decide` (pure — it evaluates and builds the decision to persist), and persist that
   * decision **in the same transaction**, so the next caller's `resolve` sees this decision's
   * declared maximum as an open charge. Without the lock, two concurrent callers both read the
   * same consumed figure and both pass `consumed + declaredMax <= limit` — READ COMMITTED does
   * not stop a read-then-write.
   */
  bindCharged(
    where: TenantScoped<BudgetQuery>,
    decide: (budget: ResolvedBudget) => TenantScoped<NewRecordedDecision>,
  ): Promise<{ readonly budget: ResolvedBudget; readonly decision: RecordedDecision }>;

  /** T064: writes the `budget_degradation` evidence record and the idempotency mark for a step,
   *  atomically, once. A re-delivery changes nothing. */
  markDegradation(where: TenantScoped<MarkDegradationInput>): Promise<MarkDegradationResult>;
}

/** A configured limit as `GET /budgets` shows it. */
export interface BudgetLimit {
  readonly scopeType: 'issue' | 'tenant';
  readonly period: BudgetPeriod;
  readonly spendLimit: number;
  readonly timeLimitMs: number;
  readonly softThresholdPcts: readonly number[];
  readonly escalationAttemptCap: number;
  readonly updatedBy: string;
}

export interface PutBudgetLimit {
  readonly scopeType: 'issue' | 'tenant';
  readonly period: BudgetPeriod;
  readonly spendLimit: number;
  readonly timeLimitMs: number;
  readonly softThresholdPcts: readonly number[];
  readonly escalationAttemptCap: number;
  readonly updatedBy: string;
  /** Builds the audit entry from the limit as it stood before — read inside the same transaction
   *  that writes the change, so "before" cannot be stale (FR-020). */
  readonly auditEntryFor: (
    before: BudgetLimit | null,
    limitId: string,
  ) => TenantScoped<NewAuditEntry>;
}

export interface BudgetLimitRepository {
  list(where: TenantScoped<object>): Promise<readonly BudgetLimit[]>;
  /** Upsert on `(tenant, scope, period)`. Returns the limit as it stood before, if any, so the
   *  audit trail can name before and after. */
  put(where: TenantScoped<PutBudgetLimit>): Promise<{ readonly before: BudgetLimit | null }>;
}
