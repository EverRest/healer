import { HealerError, type TenantScoped } from '@healer/shared';
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
 *  once. **Nothing produces this state yet**: no workflow definition transitions into it, so the
 *  count is 0 for every run today and the cap is enforced against a quantity nobody increments.
 *  A workflow whose escalation state is named differently is simply not counted; nothing reads
 *  this to flag that (`check:budget-reconcile` does not — it reconciles spend and time only). */
export const ESCALATION_TO_STATE = 'escalating';

/** Transitions into a state with this prefix (or named in `PARKED_STATES`) park the run: it is
 *  waiting on a callback or a human, not executing, so the time until its next transition is not
 *  charged against the time budget (T056, review H1). Same status as `ESCALATION_TO_STATE`:
 *  012's workflow definitions have not named their waiting states, so this is policy's one
 *  declaration of the convention and a workflow that names them otherwise is charged for waiting
 *  (conservative, fail-closed). */
export const PARKED_STATE_PREFIX = 'awaiting_';
export const PARKED_STATES = ['needs_human'] as const;

/** What one evaluation needs resolved. `asOf` is the caller's instant (the evaluator reads no
 *  clock); `workflowRunId` is what pins the period key to the run's start (T062). A named issue or
 *  run that does not exist for the tenant is an error, never a silent fallback. `enforcing` is set
 *  by the callers that persist a decision: they additionally refuse an instant too far from the
 *  database clock, because the instant selects the budget window and a backdated one would be a
 *  fresh budget. A dry run replays history, so it does not. */
export interface BudgetQuery {
  readonly issueId?: string;
  readonly workflowRunId?: string;
  readonly asOf: Date;
  readonly enforcing?: boolean;
}

/** A charge could not take the budget lock inside its bounded wait. Retryable (HTTP 429): the
 *  alternative was a pooled connection parked for as long as the queue ahead took. */
export class BudgetContentionError extends HealerError {
  constructor() {
    super('RATE_LIMITED', 'the tenant budget is busy; retry the evaluation');
    this.name = 'BudgetContentionError';
  }
}

/** `evaluatedAt` is further from the database clock than an enforcing evaluation allows. */
export class EvaluationInstantError extends HealerError {
  constructor(
    readonly skewMs: number,
    readonly maxMs: number,
  ) {
    super(
      'VALIDATION',
      `evaluatedAt is ${Math.round(skewMs / 1000)} s from the server clock; an enforcing evaluation allows ${Math.round(maxMs / 1000)} s`,
    );
    this.name = 'EvaluationInstantError';
  }
}

export interface ResolvedBudget {
  /** Every budget that applies — the tenant's day and month, plus the issue's when one is named. */
  readonly scopes: readonly ScopeFigures[];
  /** FR-013: counted from the run's escalation transitions in 012's `workflow_transition`, never
   *  from a counter kept here; the cap is the tightest `escalation_attempt_cap` that applies. */
  readonly escalation: { readonly attemptCount: number; readonly cap: number };
  /** The declared degradation order for this tenant — members of `DEGRADATION_ORDER` only. */
  readonly degradationOrder: readonly string[];
  /** Conditions in 012's configuration that were replaced by a fail-closed value (an unknown
   *  degradation entry, an out-of-range threshold). Surfaced to readers, never silent. */
  readonly warnings: readonly string[];
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
   *
   * Idempotent on the decision's `requestKey` (when it carries one and is bound to a run and
   * state): a retry of the same step returns the live allowed decision already minted instead of
   * charging again. The lock wait is bounded; past it the call fails with `BudgetContentionError`
   * (retryable) rather than queueing a pooled connection behind everyone ahead of it.
   */
  bindCharged(
    where: TenantScoped<BudgetQuery>,
    decide: (budget: ResolvedBudget) => TenantScoped<NewRecordedDecision>,
  ): Promise<{ readonly budget: ResolvedBudget; readonly decision: RecordedDecision }>;

  /** T064: writes the `budget_degradation` evidence record and the idempotency mark for a step,
   *  atomically, once. A re-delivery changes nothing. */
  markDegradation(where: TenantScoped<MarkDegradationInput>): Promise<MarkDegradationResult>;

  /**
   * Releases abandoned open charges: allowed decisions older than `olderThan` that were never
   * consumed and that no `agent_run` references — the step was never started, so nothing will ever
   * replace the charge with an actual cost. Sets `invalidated_reason = 'charge_abandoned'`, which is
   * what stops the charge counting. Returns how many were released. Takes the same lock as a
   * charge, so it cannot interleave with a resolve-and-persist.
   */
  releaseAbandonedCharges(where: TenantScoped<{ readonly olderThan: Date }>): Promise<number>;
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
  /** Omitted fields keep what is **in force** — the stored row, else 012's `tenant_budget`, else
   *  the product default — read inside the transaction that writes, so a concurrent write cannot be
   *  lost and a partial write never reverts an inherited limit to a default. */
  readonly spendLimit?: number;
  readonly timeLimitMs?: number;
  readonly softThresholdPcts?: readonly number[];
  readonly escalationAttemptCap?: number;
  readonly updatedBy: string;
  /** Builds the audit entry from the limit in force before and the merged result — read inside the same transaction
   *  that writes the change, so "before" cannot be stale (FR-020). */
  readonly auditEntryFor: (
    before: BudgetLimit,
    after: BudgetLimit,
    limitId: string,
  ) => TenantScoped<NewAuditEntry>;
}

export interface BudgetLimitRepository {
  list(where: TenantScoped<object>): Promise<readonly BudgetLimit[]>;
  /** Upsert on `(tenant, scope, period)`. Returns the limit as it stood before, if any, so the
   *  audit trail can name before and after. */
  put(where: TenantScoped<PutBudgetLimit>): Promise<{ readonly before: BudgetLimit | null }>;
}
