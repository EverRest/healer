import { NotFoundError } from '@healer/shared';
import { Prisma } from '@healer/prisma-client';
import type { BudgetPeriod } from '../domain/budget-bounds.js';
import type { ScopeFigures } from '../domain/budget-figures.js';
import {
  budgetConfigWarnings,
  effectiveLimit,
  resolveDegradationOrder,
  tightestEscalationCap,
  type EffectiveLimit,
  type LimitRow,
  type TenantBudgetRow,
} from '../domain/budget-limits.js';
import { periodKeyFor, periodWindow } from '../domain/budget-period.js';
import {
  ESCALATION_TO_STATE,
  EvaluationInstantError,
  PARKED_STATE_PREFIX,
  PARKED_STATES,
  type BudgetQuery,
  type ResolvedBudget,
} from '../domain/budget-repository.js';

// T056 (R-10): budget state is a query. Spend is `agent_run.cost`, time is `workflow_run` elapsed;
// nothing is stored here, so the number policy enforces and the number support reports cannot
// disagree — re-reading rows cannot double-charge, which a hand-maintained counter under
// at-least-once delivery can.
//
// Every statement carries `tenant_id` from the caller's authenticated context (security-and-
// tenancy.md), in the query itself.
//
// **Spend = finished cost + open charges.** An allow decision that declared a maximum
// (`budget_state.reservedSpend`) stays charged at that maximum until a *finished* `agent_run`
// references it (`agent_run.policy_decision_id`); from then on the actual cost replaces it. That
// is what lets a second evaluation see the first one's charge before the step has run (R-11), and
// what makes consumption never exceed the limit under a flood.

type Db = Prisma.TransactionClient;

/** The instant a charge is keyed by (T061/T062): the run's *start*, so every step of a workflow
 *  that straddles midnight stays in the window in force when it was requested. A run the table
 *  does not know falls back to the caller's instant. (An agent run or decision that happened
 *  *before* its workflow was started — classified at ingest, say — is keyed by its own earlier
 *  instant: `LEAST` in the aggregates below. That is also what makes pruning the scan on
 *  `started_at >= window.start` sound.) */
async function pinnedInstant(db: Db, tenantId: string, query: BudgetQuery): Promise<Date> {
  if (query.workflowRunId === undefined) return query.asOf;
  // An unknown, malformed or other-tenant run is an error, never a quiet fall-back to the caller's
  // instant: falling back would hand a bogus run id a fresh budget window, and counting nothing for
  // it would hide the mistake. Not-found, not forbidden (FR-018).
  if (!UUID.test(query.workflowRunId)) throw new NotFoundError('WorkflowRun');
  const rows = await db.$queryRaw<{ started_at: Date }[]>`
    SELECT started_at FROM "workflow"."workflow_run"
    WHERE tenant_id = ${tenantId}::uuid AND id = ${query.workflowRunId}::uuid`;
  if (rows[0] === undefined) throw new NotFoundError('WorkflowRun');
  return rows[0].started_at;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a *named* issue and an *enforcing* evaluation require before anything is read or charged. */
async function assertEvaluable(
  db: Db,
  tenantId: string,
  query: BudgetQuery,
  maxSkewMs: number,
): Promise<void> {
  if (query.issueId !== undefined) {
    if (!UUID.test(query.issueId)) throw new NotFoundError('Issue');
    const rows = await db.$queryRaw<{ one: number }[]>`
      SELECT 1 AS one FROM "issue"."issue"
      WHERE tenant_id = ${tenantId}::uuid AND id = ${query.issueId}::uuid`;
    if (rows[0] === undefined) throw new NotFoundError('Issue');
  }
  if (query.enforcing === true && Number.isFinite(maxSkewMs)) {
    // The instant selects the budget window (a run-less evaluation is keyed by it), so an
    // enforcing evaluation whose instant is far from the database clock is a way to spend in a
    // window that is not the present one.
    const [now] = await db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    const skew = Math.abs(query.asOf.getTime() - (now?.now ?? query.asOf).getTime());
    if (skew > maxSkewMs) throw new EvaluationInstantError(skew, maxSkewMs);
  }
}

export async function loadLimits(
  db: Db,
  tenantId: string,
  issueId: string | undefined,
): Promise<{ rows: LimitRow[]; tenantBudgets: TenantBudgetRow[] }> {
  const limits = await db.$queryRaw<
    {
      scope_type: 'issue' | 'tenant';
      scope_id: string | null;
      period: BudgetPeriod;
      spend_limit: number;
      time_limit_ms: number;
      soft_threshold_pcts: number[] | null;
      escalation_attempt_cap: number;
    }[]
  >`
    SELECT scope_type::text AS scope_type, scope_id::text AS scope_id, period::text AS period,
           spend_limit::float8 AS spend_limit, time_limit_ms, soft_threshold_pcts,
           escalation_attempt_cap
    FROM "policy"."budget_limit"
    WHERE tenant_id = ${tenantId}::uuid
      AND ((scope_type = 'tenant' AND scope_id IS NULL)
        OR (scope_type = 'issue' AND (scope_id IS NULL OR scope_id = ${issueId ?? null}::uuid)))`;
  const inherited = await db.$queryRaw<
    {
      period: 'day' | 'month';
      spend_limit: number;
      time_limit: number;
      soft_threshold_pcts: number[] | null;
      degradation_order: string[] | null;
    }[]
  >`
    SELECT period::text AS period, spend_limit::float8 AS spend_limit, time_limit,
           soft_threshold_pcts, degradation_order
    FROM "tenant"."tenant_budget" WHERE tenant_id = ${tenantId}::uuid`;
  return {
    rows: limits.map((r) => ({
      scopeType: r.scope_type,
      scopeId: r.scope_id,
      period: r.period,
      spendLimit: r.spend_limit,
      timeLimitMs: r.time_limit_ms,
      softThresholdPcts: r.soft_threshold_pcts,
      escalationAttemptCap: r.escalation_attempt_cap,
    })),
    tenantBudgets: inherited.map((r) => ({
      period: r.period,
      spendLimit: r.spend_limit,
      timeLimitMs: r.time_limit,
      softThresholdPcts: r.soft_threshold_pcts,
      degradationOrder: r.degradation_order ?? [],
    })),
  };
}

export interface Consumption {
  readonly spend: number;
  readonly timeMs: number;
}

/**
 * The **active** elapsed time of a run, in ms (T056, review H1): from its start to its last update
 * when terminal, to the caller's instant while live — minus the time it spent *parked*. A run is
 * parked from a transition into a state named `awaiting_*` (or in `PARKED_STATES`) until its next
 * transition; waiting on an approver or a callback is not execution, and charging it would let one
 * slow human exhaust an issue's time budget. Derived from `workflow_transition`, the history 012
 * already keeps — no second record of waiting. SQL text, shared by the tenant and issue queries.
 */
function activeElapsedMs(asOf: Date): Prisma.Sql {
  const end = Prisma.sql`(CASE WHEN wr.terminal_state IS NOT NULL THEN wr.updated_at ELSE ${asOf}::timestamptz END)`;
  return Prisma.sql`GREATEST(0, EXTRACT(EPOCH FROM (${end} - wr.started_at)) * 1000 - COALESCE((
    SELECT SUM(GREATEST(0, EXTRACT(EPOCH FROM (LEAST(COALESCE(t.next_at, ${end}), ${end}) - t.occurred_at)) * 1000))
    FROM (SELECT tr.to_state, tr.occurred_at,
                 lead(tr.occurred_at) OVER (ORDER BY tr.occurred_at, tr.id) AS next_at
          FROM "workflow"."workflow_transition" tr
          WHERE tr.tenant_id = wr.tenant_id AND tr.run_id = wr.id) t
    WHERE starts_with(t.to_state, ${PARKED_STATE_PREFIX}::text)
       OR t.to_state IN (${Prisma.join([...PARKED_STATES])})), 0))`;
}

export async function tenantConsumption(
  db: Db,
  tenantId: string,
  window: { start: Date; end: Date },
  asOf: Date,
): Promise<Consumption> {
  const [finished] = await db.$queryRaw<{ v: number }[]>`
    SELECT COALESCE(SUM(ar.cost), 0)::float8 AS v
    FROM "agent"."agent_run" ar
    CROSS JOIN LATERAL (
      SELECT LEAST(ar.started_at, COALESCE(min(wr.started_at), ar.started_at)) AS pinned
      FROM "workflow"."workflow_run" wr
      WHERE wr.tenant_id = ar.tenant_id AND wr.correlation_id = ar.correlation_id) p
    WHERE ar.tenant_id = ${tenantId}::uuid
      AND ar.started_at >= ${window.start}::timestamptz
      AND p.pinned >= ${window.start}::timestamptz AND p.pinned < ${window.end}::timestamptz`;
  const [open] = await db.$queryRaw<{ v: number }[]>`
    SELECT COALESCE(SUM((pd.budget_state->>'reservedSpend')::numeric), 0)::float8 AS v
    FROM "policy"."policy_decision" pd
    CROSS JOIN LATERAL (
      SELECT LEAST(pd.evaluated_at, COALESCE(min(wr.started_at), pd.evaluated_at)) AS pinned
      FROM "workflow"."workflow_run" wr
      WHERE wr.tenant_id = pd.tenant_id AND wr.id = pd.workflow_run_id) p
    WHERE pd.tenant_id = ${tenantId}::uuid AND pd.outcome = 'allow' AND pd.invalidated_reason IS NULL
      AND pd.evaluated_at >= ${window.start}::timestamptz
      AND p.pinned >= ${window.start}::timestamptz AND p.pinned < ${window.end}::timestamptz
      AND NOT EXISTS (SELECT 1 FROM "agent"."agent_run" ar
                      WHERE ar.tenant_id = pd.tenant_id AND ar.policy_decision_id = pd.id
                        AND ar.finished_at IS NOT NULL)`;
  const [time] = await db.$queryRaw<{ v: number }[]>`
    SELECT COALESCE(SUM(${activeElapsedMs(asOf)}), 0)::float8 AS v
    FROM "workflow"."workflow_run" wr
    WHERE wr.tenant_id = ${tenantId}::uuid
      AND wr.started_at >= ${window.start}::timestamptz AND wr.started_at < ${window.end}::timestamptz`;
  return { spend: (finished?.v ?? 0) + (open?.v ?? 0), timeMs: time?.v ?? 0 };
}

export async function issueConsumption(
  db: Db,
  tenantId: string,
  issueId: string,
  asOf: Date,
): Promise<Consumption> {
  const [finished] = await db.$queryRaw<{ v: number }[]>`
    SELECT COALESCE(SUM(cost), 0)::float8 AS v FROM "agent"."agent_run"
    WHERE tenant_id = ${tenantId}::uuid AND issue_id = ${issueId}::uuid`;
  const [open] = await db.$queryRaw<{ v: number }[]>`
    SELECT COALESCE(SUM((pd.budget_state->>'reservedSpend')::numeric), 0)::float8 AS v
    FROM "policy"."policy_decision" pd
    WHERE pd.tenant_id = ${tenantId}::uuid AND pd.issue_id = ${issueId}::uuid
      AND pd.outcome = 'allow' AND pd.invalidated_reason IS NULL
      AND NOT EXISTS (SELECT 1 FROM "agent"."agent_run" ar
                      WHERE ar.tenant_id = pd.tenant_id AND ar.policy_decision_id = pd.id
                        AND ar.finished_at IS NOT NULL)`;
  const [time] = await db.$queryRaw<{ v: number }[]>`
    SELECT COALESCE(SUM(${activeElapsedMs(asOf)}), 0)::float8 AS v
    FROM "workflow"."workflow_run" wr
    WHERE wr.tenant_id = ${tenantId}::uuid AND wr.issue_id = ${issueId}::uuid`;
  return { spend: (finished?.v ?? 0) + (open?.v ?? 0), timeMs: time?.v ?? 0 };
}

/** FR-013: escalation attempts recorded on the workflow run (012) — counted from its
 *  transitions, never from a counter kept here. */
async function escalationAttempts(
  db: Db,
  tenantId: string,
  workflowRunId: string | undefined,
): Promise<number> {
  if (workflowRunId === undefined) return 0;
  const [row] = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM "workflow"."workflow_transition"
    WHERE tenant_id = ${tenantId}::uuid AND run_id = ${workflowRunId}::uuid
      AND to_state = ${ESCALATION_TO_STATE}`;
  return row?.n ?? 0;
}

const figures = (
  scopeType: 'issue' | 'tenant',
  scopeId: string,
  period: BudgetPeriod,
  periodKey: string,
  limit: EffectiveLimit,
  used: Consumption,
): ScopeFigures => ({
  scopeType,
  scopeId,
  period,
  periodKey,
  spendConsumed: used.spend,
  spendLimit: limit.spendLimit,
  timeConsumedMs: used.timeMs,
  timeLimitMs: limit.timeLimitMs,
  softThresholdPcts: limit.softThresholdPcts,
});

/**
 * The derived budget for one evaluation: the tenant's day and month (keyed by the run's pinned
 * start, T062) and, when an issue is named, that issue's own budget. Callable inside a
 * transaction, so the charge lock (T060) can read exactly what it then writes against.
 */
export async function resolveBudget(
  db: Db,
  tenantId: string,
  query: BudgetQuery,
  maxSkewMs: number,
): Promise<ResolvedBudget> {
  await assertEvaluable(db, tenantId, query, maxSkewMs);
  const pinned = await pinnedInstant(db, tenantId, query);
  const { rows, tenantBudgets } = await loadLimits(db, tenantId, query.issueId);

  const scopes: ScopeFigures[] = [];
  const caps: (number | null)[] = [];
  for (const period of ['day', 'month'] as const) {
    const window = periodWindow(period, pinned);
    if (window === null) continue;
    const limit = effectiveLimit({ scopeType: 'tenant', period }, rows, tenantBudgets);
    caps.push(limit.escalationAttemptCap);
    scopes.push(
      figures(
        'tenant',
        tenantId,
        period,
        periodKeyFor(period, pinned),
        limit,
        await tenantConsumption(db, tenantId, window, query.asOf),
      ),
    );
  }
  if (query.issueId !== undefined) {
    const limit = effectiveLimit({ scopeType: 'issue' }, rows, tenantBudgets, query.issueId);
    caps.push(limit.escalationAttemptCap);
    scopes.push(
      figures(
        'issue',
        query.issueId,
        'issue',
        periodKeyFor('issue', pinned),
        limit,
        await issueConsumption(db, tenantId, query.issueId, query.asOf),
      ),
    );
  }

  return {
    scopes,
    escalation: {
      attemptCount: await escalationAttempts(db, tenantId, query.workflowRunId),
      cap: tightestEscalationCap(caps),
    },
    degradationOrder: resolveDegradationOrder(tenantBudgets),
    warnings: budgetConfigWarnings(tenantBudgets),
  };
}
