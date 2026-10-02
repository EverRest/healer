import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { budgetLockKey } from '@healer/domain-policy';
import { findBudgetDiscrepancies } from './scripts/checks/budget-reconcile.mjs';
import { query, type StartedPostgres } from './test/containers.js';
import {
  hold,
  seedAgentRun,
  seededPromptVersionId,
  seedIssue,
  seedTransition,
  seedWorkflowRun,
  waitForBlocked,
} from './test/budget-fixtures.js';
import {
  NOON,
  startBudgetHarness,
  type BudgetHarness,
} from './test/infrastructure/budget-harness.js';

/**
 * 002 Phase 6 (US4) against a real Postgres: T056 (the aggregate is derived, never stored), T058
 * (a budget-limited issue), T059/T060 (the ex-ante charge, and the lock that makes it hold under
 * concurrency), T061/T062 (the period key is pinned to the run's start), T066 (the escalation
 * cap), T088 (the bounds bind a direct write too). The degradation evidence record (T064) and the
 * 400-issue flood (T065) are `budget-degradation.e2e.test.ts` and `budget-flood.e2e.test.ts`.
 */
// An escalating proposal: the one the escalation cap applies to (T066).
const ESCALATING = { escalation: { attemptCount: 0, escalating: true } } as const;

describe('budget enforcement (002 T056-T066, T088)', () => {
  let h: BudgetHarness;
  let pg: StartedPostgres;
  let prisma: BudgetHarness['prisma'];
  let setLimit: BudgetHarness['setLimit'];
  let bind: BudgetHarness['bind'];
  let resolve: BudgetHarness['resolve'];
  let tenantDay: BudgetHarness['tenantDay'];
  let newTenant: BudgetHarness['newTenant'];

  beforeAll(async () => {
    h = await startBudgetHarness();
    ({ pg, prisma, setLimit, bind, resolve, tenantDay, newTenant } = h);
  }, 180_000);

  afterAll(async () => {
    await h?.stop();
  });

  describe('T056 — consumption is derived, never stored', () => {
    it('spend is finished agent_run cost plus the open charge of an allowed step, replaced by the actual cost when the run lands', async () => {
      const { tenantId, ctx } = await newTenant();
      await setLimit(ctx, { spendLimit: 100 });
      await seedAgentRun(pg, { tenantId, cost: 3, startedAt: '2026-10-02T10:00:00Z' });
      // a run still in flight costs nothing yet: its declared maximum is carried by its decision
      await seedAgentRun(pg, {
        tenantId,
        cost: 0,
        startedAt: '2026-10-02T10:30:00Z',
        finishedAt: null,
      });

      const { decision } = await bind(ctx, 2);
      expect(decision.outcome).toBe('allow');
      expect(tenantDay(await resolve(ctx)).spendConsumed).toBe(5); // 3 actual + 2 declared

      // the step runs and finishes cheaper than declared: the actual cost replaces the charge
      await seedAgentRun(pg, {
        tenantId,
        cost: 1.5,
        startedAt: '2026-10-02T11:00:00Z',
        policyDecisionId: decision.id,
      });
      expect(tenantDay(await resolve(ctx)).spendConsumed).toBe(4.5);
    });

    it("never counts another tenant's spend (FR-018)", async () => {
      const a = await newTenant();
      const b = await newTenant();
      await seedAgentRun(pg, { tenantId: b.tenantId, cost: 7, startedAt: '2026-10-02T10:00:00Z' });
      expect(tenantDay(await resolve(a.ctx)).spendConsumed).toBe(0);
      expect(tenantDay(await resolve(b.ctx)).spendConsumed).toBe(7);
    });

    it('time is workflow_run elapsed: to its last update when terminal, to the evaluation instant while live', async () => {
      const { tenantId, ctx } = await newTenant();
      const issueId = await seedIssue(pg, tenantId);
      await seedWorkflowRun(pg, {
        tenantId,
        issueId,
        startedAt: '2026-10-02T10:00:00Z',
        endedAt: '2026-10-02T10:30:00Z',
      });
      await seedWorkflowRun(pg, { tenantId, issueId, startedAt: '2026-10-02T11:00:00Z' });
      const day = tenantDay(await resolve(ctx, {}, new Date('2026-10-02T11:10:00Z')));
      expect(day.timeConsumedMs).toBe(1_800_000 + 600_000);
    });

    it("inherits 012's tenant_budget when no budget_limit row exists, and falls back to the fail-closed default otherwise (T057)", async () => {
      const { tenantId, ctx } = await newTenant();
      await query(
        pg,
        `insert into "tenant"."tenant_budget"
           (tenant_id, period, spend_limit, time_limit, soft_threshold_pcts, degradation_order, updated_at)
         values ('${tenantId}', 'day', 7, 5000, '{60,80}', '{diagnosis_only}', now())`,
      );
      const b = await resolve(ctx);
      expect(tenantDay(b)).toMatchObject({
        spendLimit: 7,
        timeLimitMs: 5000,
        softThresholdPcts: [60, 80],
      });
      expect(b.degradationOrder).toEqual(['diagnosis_only']);
      const month = b.scopes.find((s) => s.period === 'month')!;
      expect(month.spendLimit).toBe(200); // the product's fail-closed default, never unbounded
    });
  });

  describe('T058 — an issue past its budget', () => {
    it('is refused (not failed), marked budget-limited with what completed, and resumes when the limit is raised', async () => {
      const { tenantId, ctx } = await newTenant();
      await setLimit(ctx, { scopeType: 'issue', period: 'issue', spendLimit: 1 });
      const issueId = await seedIssue(pg, tenantId);
      const completedRun = await seedAgentRun(pg, { tenantId, issueId, cost: 1 });

      const { decision } = await bind(ctx, 0.1, { issueId });
      expect(decision.outcome).toBe('deny');
      expect(decision.reasonCodes).toContain('BUDGET_EXHAUSTED');

      const evidence = await prisma.evidence.findMany({
        where: { tenantId, issueId, type: 'budget_degradation' },
        orderBy: { observedAt: 'asc' },
      });
      const last = evidence.at(-1)?.payload as Record<string, unknown>;
      expect(last).toMatchObject({ entryApplied: 'ai_steps_refused', scopeType: 'issue' });
      expect(last['completedAgentRuns']).toEqual([
        { agentRunId: completedRun, agentKind: 'investigator', outcome: 'ok' },
      ]);

      // resumable: nothing was discarded, and the same step proceeds once the budget allows it
      await setLimit(ctx, { scopeType: 'issue', period: 'issue', spendLimit: 5 });
      const resumed = await bind(ctx, 0.1, { issueId });
      expect(resumed.decision.outcome).toBe('allow');
    });
  });

  describe('T059/T060 — the ex-ante charge', () => {
    async function chargedTotals(tenantId: string): Promise<number> {
      const [row] = await prisma.$queryRaw<{ v: number }[]>`
        SELECT (COALESCE((SELECT SUM(cost) FROM "agent"."agent_run" WHERE tenant_id = ${tenantId}::uuid), 0)
              + COALESCE((SELECT SUM((budget_state->>'reservedSpend')::numeric)
                          FROM "policy"."policy_decision"
                          WHERE tenant_id = ${tenantId}::uuid AND outcome = 'allow'), 0))::float8 AS v`;
      return row!.v;
    }

    it('refuses a step whose declared maximum would cross the limit before it runs; consumption never exceeds the limit', async () => {
      const { tenantId, ctx } = await newTenant();
      await setLimit(ctx, { spendLimit: 10 });
      await seedAgentRun(pg, { tenantId, cost: 9.5, startedAt: '2026-10-02T10:00:00Z' });

      const crossing = await bind(ctx, 1);
      expect(crossing.decision.outcome).toBe('deny'); // consumed 9.5 < 10, yet 9.5 + 1 > 10
      expect(crossing.decision.reasonCodes).toContain('BUDGET_EXHAUSTED');

      expect((await bind(ctx, 0.5)).decision.outcome).toBe('allow'); // lands exactly on the limit
      expect((await bind(ctx, 0.01)).decision.outcome).toBe('deny'); // the charge is already visible
      expect(await chargedTotals(tenantId)).toBeLessThanOrEqual(10);
    });

    it('a charge waits behind the serialization lock and then reads what the holder committed', async () => {
      const { tenantId, ctx } = await newTenant();
      await setLimit(ctx, { spendLimit: 10 });

      // Another charge is mid-flight: it holds the tenant's budget lock and has not committed the
      // cost that will make the limit unreachable.
      const holder = await hold(
        prisma,
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${budgetLockKey(tenantId)}, 0))`;
        },
        async (tx) => {
          await tx.$executeRaw`
            INSERT INTO "agent"."agent_run"
              (id, tenant_id, correlation_id, agent_kind, prompt_version_id, model_id, provider,
               input_tokens, output_tokens, cost, tool_calls, outcome, started_at, finished_at)
            VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${randomUUID()}::uuid, 'investigator',
                    ${seededPromptVersionId()}::uuid, 'm', 'anthropic', 1, 1, 9.5, '[]'::jsonb, 'ok',
                    ${NOON}::timestamptz, ${NOON}::timestamptz)`;
        },
      );

      let settled = false;
      const pending = bind(ctx, 1).finally(() => {
        settled = true;
      });
      await waitForBlocked(pg, 1, holder); // polls pg_stat_activity; no sleep stands in for it
      expect(settled).toBe(false);

      await holder.release();
      // It read *after* the holder committed 9.5: 9.5 + 1 > 10. Without the lock it would have
      // read 0 while the holder was still open, and been allowed.
      expect((await pending).decision.outcome).toBe('deny');
    });

    it('under concurrent charges exactly as many are allowed as fit, and the total never exceeds the limit', async () => {
      const { tenantId, ctx } = await newTenant();
      await setLimit(ctx, { spendLimit: 10 });
      const results = await Promise.all(Array.from({ length: 20 }, () => bind(ctx, 1)));
      expect(results.filter((r) => r.decision.outcome === 'allow')).toHaveLength(10);
      expect(await chargedTotals(tenantId)).toBe(10);
    });

    it('a step that declares no cost takes no lock: it is not queued behind a held charge', async () => {
      const { tenantId, ctx } = await newTenant();
      const holder = await hold(prisma, async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${budgetLockKey(tenantId)}, 0))`;
      });
      try {
        expect((await bind(ctx, 0)).decision.outcome).toBe('allow');
      } finally {
        await holder.release();
      }
    });
  });

  describe('T061/T062 — the period key is pinned at request time', () => {
    it('charges stay in the key pinned at the run start; straddling midnight gains no fresh budget', async () => {
      const { tenantId, ctx } = await newTenant();
      await setLimit(ctx, { spendLimit: 10 });
      const issueId = await seedIssue(pg, tenantId);
      const run = await seedWorkflowRun(pg, {
        tenantId,
        issueId,
        startedAt: '2026-10-02T23:55:00Z',
      });
      // eight spent before midnight, one more by the same run after it
      await seedAgentRun(pg, {
        tenantId,
        cost: 8,
        correlationId: run.correlationId,
        startedAt: '2026-10-02T23:56:00Z',
      });
      await seedAgentRun(pg, {
        tenantId,
        cost: 1,
        correlationId: run.correlationId,
        startedAt: '2026-10-03T00:10:00Z',
      });

      const afterMidnight = new Date('2026-10-03T00:20:00Z');
      const pinned = await bind(ctx, 2, { workflowRunId: run.id }, afterMidnight);
      // 9 spent in the window pinned at 23:55 + 2 declared > 10. An unpinned evaluation would have
      // read a fresh 2026-10-03 and allowed it.
      expect(pinned.decision.outcome).toBe('deny');
      const stored = await prisma.policyDecision.findUnique({ where: { id: pinned.decision.id } });
      expect(stored?.budgetState).toMatchObject({
        binding: { period: 'day', periodKey: '2026-10-02' },
        consumed: 9,
      });

      // A run that *starts* after midnight is in the new window, with none of the old run's spend.
      const fresh = await seedWorkflowRun(pg, {
        tenantId,
        issueId,
        startedAt: '2026-10-03T00:05:00Z',
      });
      const next = await bind(ctx, 2, { workflowRunId: fresh.id }, afterMidnight);
      expect(next.decision.outcome).toBe('allow');
      expect(
        tenantDay(await resolve(ctx, { workflowRunId: fresh.id }, afterMidnight)),
      ).toMatchObject({
        periodKey: '2026-10-03',
        spendConsumed: 2,
      });
    });
  });

  describe('T066 — the escalation attempt cap', () => {
    it('reads the attempt count from the run, stops escalation at the cap, and a raised cap resumes it', async () => {
      const { tenantId, ctx } = await newTenant();
      await setLimit(ctx, { spendLimit: 100, escalationAttemptCap: 2 });
      const issueId = await seedIssue(pg, tenantId);
      const run = await seedWorkflowRun(pg, {
        tenantId,
        issueId,
        startedAt: '2026-10-02T11:00:00Z',
      });

      const escalate = () => bind(ctx, 1, { workflowRunId: run.id }, NOON, ESCALATING);
      const ordinary = () => bind(ctx, 1, { workflowRunId: run.id });

      await seedTransition(pg, tenantId, run.id, 'escalating');
      expect((await escalate()).decision.outcome).toBe('allow');

      await seedTransition(pg, tenantId, run.id, 'escalating');
      const stopped = await escalate();
      expect(stopped.decision.outcome).toBe('deny');
      expect(stopped.decision.reasonCodes).toContain('ESCALATION_CAP_REACHED');
      // the cap bounds escalation, not the run: a non-escalating step is still allowed
      expect((await ordinary()).decision.outcome).toBe('allow');

      // other states do not count as escalation
      await seedTransition(pg, tenantId, run.id, 'collecting');
      await setLimit(ctx, { spendLimit: 100, escalationAttemptCap: 3 });
      expect((await escalate()).decision.outcome).toBe('allow');
    });

    it('an unconfigured tenant runs on the fail-closed default cap, never an unbounded one', async () => {
      const { tenantId, ctx } = await newTenant();
      const issueId = await seedIssue(pg, tenantId);
      const run = await seedWorkflowRun(pg, {
        tenantId,
        issueId,
        startedAt: '2026-10-02T11:00:00Z',
      });
      await seedTransition(pg, tenantId, run.id, 'escalating');
      await seedTransition(pg, tenantId, run.id, 'escalating');
      const decided = await bind(ctx, 0.1, { workflowRunId: run.id }, NOON, ESCALATING);
      expect(decided.decision.reasonCodes).toContain('ESCALATION_CAP_REACHED');
    });
  });

  describe('T088 — the product bounds bind a direct write too', () => {
    const insert = (cap: number, spend: number, period = 'day', scopeType = 'tenant') =>
      query(
        pg,
        `insert into "policy"."budget_limit"
           (id, tenant_id, scope_type, scope_id, period, spend_limit, time_limit_ms,
            soft_threshold_pcts, escalation_attempt_cap, updated_at, updated_by)
         values ('${randomUUID()}', '${randomUUID()}', '${scopeType}', null, '${period}', ${spend}, 1000,
                 '{50}', ${cap}, now(), 'sql')`,
      );

    it('refuses an escalation attempt cap above the bound, written around the API', async () => {
      await expect(insert(6, 1)).rejects.toThrow(/budget_limit_escalation_attempt_cap_bound/);
      await expect(insert(5, 1)).resolves.not.toThrow();
    });

    it('refuses a spend limit above the per-period bound', async () => {
      await expect(insert(2, 501)).rejects.toThrow(/budget_limit_spend_limit_bound/);
      await expect(insert(2, 51, 'issue', 'issue')).rejects.toThrow(
        /budget_limit_spend_limit_bound/,
      );
    });

    it('refuses a scope/period pairing the product has no budget for', async () => {
      await expect(insert(2, 1, 'issue', 'tenant')).rejects.toThrow(/budget_limit_scope_period/);
    });
  });

  // The reader of everything above (T069): after all of these scenarios, the aggregate policy
  // enforced still matches the rows it was derived from. Part of `make ci` through this file.
  it('check:budget-reconcile finds nothing in the data these scenarios left behind', async () => {
    expect(await findBudgetDiscrepancies(prisma)).toEqual([]);
  });
});
