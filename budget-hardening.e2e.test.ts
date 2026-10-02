import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BUDGET_LOCK_WAIT_MS,
  BudgetContentionError,
  budgetLockKey,
  EvaluationInstantError,
  evaluateAndBind,
  explainDecision,
  PrismaBudgetRepository,
  releaseAbandonedCharges,
  type EvaluateAndBindRepos,
} from '@healer/domain-policy';
import { PrismaIssueDeletionRepository, deleteIssue } from '@healer/domain-issues';
import { NotFoundError, TenantContext, scope, withCorrelation } from '@healer/shared';
import { query } from './test/containers.js';
import {
  decisionInput,
  hold,
  seedAgentRun,
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
 * Review fixes to 002 Phase 6 (coordinator's two independent reviews), against a real Postgres:
 * an idempotent charge, a bound that holds before anything is charged, a release path for
 * abandoned charges, active-only time, a bounded lock wait, an enforcing instant that cannot be
 * backdated, and dry-run/enforcing parity.
 */
describe('budget hardening (review fixes)', () => {
  let h: BudgetHarness;
  const issueDeletion = () => new PrismaIssueDeletionRepository(h.prisma);

  beforeAll(async () => {
    h = await startBudgetHarness();
  }, 180_000);

  afterAll(async () => {
    await h?.stop();
  });

  const decisionCount = (tenantId: string) =>
    h.prisma.policyDecision.count({ where: { tenantId } });

  /** A charged step bound to a run and a state — what a retry would resend verbatim. */
  const bindStep = (
    ctx: TenantContext,
    declared: number,
    binding: { issueId?: string; workflowRunId: string; workflowState: string },
    at = NOON,
  ) =>
    withCorrelation(randomUUID(), () =>
      evaluateAndBind(h.repos, ctx, { decisionInput: decisionInput(declared, at), binding }),
    );

  describe('idempotent charge (H2/C2)', () => {
    async function runFor(ctxTenant: { tenantId: string }) {
      // the per-issue default (2) would refuse these charges before the key is ever in play
      await h.setLimit(TenantContext.forTrustedInternalUse(ctxTenant.tenantId), {
        scopeType: 'issue',
        period: 'issue',
        spendLimit: 50,
      });
      const issueId = await seedIssue(h.pg, ctxTenant.tenantId);
      const run = await seedWorkflowRun(h.pg, {
        tenantId: ctxTenant.tenantId,
        issueId,
        startedAt: NOON.toISOString(),
      });
      return { issueId, runId: run.id };
    }

    it('a retried step returns the decision it already minted, and charges once', async () => {
      const t = await h.newTenant();
      await h.setLimit(t.ctx, { spendLimit: 10 });
      const { issueId, runId } = await runFor(t);
      const binding = { issueId, workflowRunId: runId, workflowState: 'diagnosing' };

      const first = await bindStep(t.ctx, 4, binding);
      // the retry arrives with a later instant and the budget has moved; same step, same key
      const retry = await bindStep(t.ctx, 4, binding, new Date(NOON.getTime() + 60_000));
      expect(retry.decision.id).toBe(first.decision.id);
      expect(await decisionCount(t.tenantId)).toBe(1);
      expect(h.tenantDay(await h.resolve(t.ctx, { workflowRunId: runId })).spendConsumed).toBe(4);
    });

    it('concurrent retries of one step mint exactly one charged decision', async () => {
      const t = await h.newTenant();
      await h.setLimit(t.ctx, { spendLimit: 10 });
      const { issueId, runId } = await runFor(t);
      const binding = { issueId, workflowRunId: runId, workflowState: 'diagnosing' };
      const results = await Promise.all(
        Array.from({ length: 6 }, () => bindStep(t.ctx, 3, binding)),
      );
      expect(new Set(results.map((r) => r.decision.id)).size).toBe(1);
      expect(await decisionCount(t.tenantId)).toBe(1);
    });

    it('a different state, or a different declared maximum, is a different step and charges again', async () => {
      const t = await h.newTenant();
      await h.setLimit(t.ctx, { spendLimit: 20 });
      const { issueId, runId } = await runFor(t);
      const a = await bindStep(t.ctx, 3, { issueId, workflowRunId: runId, workflowState: 'one' });
      const b = await bindStep(t.ctx, 3, { issueId, workflowRunId: runId, workflowState: 'two' });
      const c = await bindStep(t.ctx, 4, { issueId, workflowRunId: runId, workflowState: 'one' });
      expect(new Set([a, b, c].map((r) => r.decision.id)).size).toBe(3);
    });

    it('once the first decision is invalidated, a re-request is a new decision', async () => {
      const t = await h.newTenant();
      await h.setLimit(t.ctx, { spendLimit: 10 });
      const { issueId, runId } = await runFor(t);
      const binding = { issueId, workflowRunId: runId, workflowState: 'diagnosing' };
      const first = await bindStep(t.ctx, 3, binding);
      await h.prisma.policyDecision.update({
        where: { id: first.decision.id },
        data: { invalidatedReason: 'epoch_bump' },
      });
      const again = await bindStep(t.ctx, 3, binding);
      expect(again.decision.id).not.toBe(first.decision.id);
    });

    it('a step bound to no run and state cannot be deduplicated — each call is its own request', async () => {
      const t = await h.newTenant();
      await h.setLimit(t.ctx, { spendLimit: 10 });
      const a = await h.bind(t.ctx, 2);
      const b = await h.bind(t.ctx, 2);
      expect(a.decision.id).not.toBe(b.decision.id);
    });
  });

  describe('a bad binding fails before anything is charged (review #6)', () => {
    it('an unknown issue is not-found and commits no decision and no charge', async () => {
      const t = await h.newTenant();
      await h.setLimit(t.ctx, { spendLimit: 10 });
      await expect(h.bind(t.ctx, 3, { issueId: randomUUID() })).rejects.toThrow(NotFoundError);
      expect(await decisionCount(t.tenantId)).toBe(0);
    });

    it("another tenant's issue is not-found too, never forbidden", async () => {
      const a = await h.newTenant();
      const b = await h.newTenant();
      const theirs = await seedIssue(h.pg, b.tenantId);
      await expect(h.bind(a.ctx, 3, { issueId: theirs })).rejects.toThrow(NotFoundError);
    });

    it('an unknown or other-tenant workflow run is an error, never a fresh window or a zero count', async () => {
      const a = await h.newTenant();
      const b = await h.newTenant();
      const issue = await seedIssue(h.pg, b.tenantId);
      const theirs = await seedWorkflowRun(h.pg, {
        tenantId: b.tenantId,
        issueId: issue,
        startedAt: NOON.toISOString(),
      });
      await expect(h.bind(a.ctx, 3, { workflowRunId: randomUUID() })).rejects.toThrow(
        NotFoundError,
      );
      await expect(h.bind(a.ctx, 3, { workflowRunId: theirs.id })).rejects.toThrow(NotFoundError);
      await expect(h.bind(a.ctx, 3, { workflowRunId: 'not-a-uuid' })).rejects.toThrow(
        NotFoundError,
      );
      expect(await decisionCount(a.tenantId)).toBe(0);
    });

    it('the same refusal on a read: resolving a bogus run is an error', async () => {
      const t = await h.newTenant();
      await expect(h.resolve(t.ctx, { workflowRunId: randomUUID() })).rejects.toThrow(
        NotFoundError,
      );
    });
  });

  describe('an enforcing instant cannot be backdated (review #6)', () => {
    it('refuses an evaluatedAt far from the server clock, and accepts one near it', async () => {
      const strict = new PrismaBudgetRepository(h.prisma); // the default bound
      const repos: EvaluateAndBindRepos = { ...h.repos, budgets: strict };
      const t = await h.newTenant();
      const go = (at: Date) =>
        withCorrelation(randomUUID(), () =>
          evaluateAndBind(repos, t.ctx, { decisionInput: decisionInput(0, at) }),
        );
      await expect(go(new Date(Date.now() - 3_600_000))).rejects.toThrow(EvaluationInstantError);
      await expect(go(new Date(Date.now() + 3_600_000))).rejects.toThrow(EvaluationInstantError);
      await expect(go(new Date())).resolves.toBeDefined();
    });

    it('a read (a dry run replaying history) is not bound by the clock', async () => {
      const strict = new PrismaBudgetRepository(h.prisma);
      const t = await h.newTenant();
      await expect(
        strict.resolve(scope(t.ctx, { asOf: new Date('2020-01-01T00:00:00Z') })),
      ).resolves.toBeDefined();
    });
  });

  describe('abandoned charges are released (silent-failure #1)', () => {
    it('a charge whose step never ran exhausts the issue; releasing it lets the next step proceed', async () => {
      const t = await h.newTenant();
      await h.setLimit(t.ctx, { scopeType: 'issue', period: 'issue', spendLimit: 2 });
      await h.setLimit(t.ctx, { spendLimit: 100 });
      const issueId = await seedIssue(h.pg, t.tenantId);

      const stuck = await h.bind(t.ctx, 2, { issueId });
      expect(stuck.decision.outcome).toBe('allow');
      expect((await h.bind(t.ctx, 0.5, { issueId })).decision.outcome).toBe('deny'); // locked out

      const later = new Date(NOON.getTime() + 3 * 3_600_000);
      const released = await releaseAbandonedCharges(h.budgets, t.ctx, { now: later });
      expect(released).toBe(1);
      const row = await h.prisma.policyDecision.findUnique({ where: { id: stuck.decision.id } });
      expect(row?.invalidatedReason).toBe('charge_abandoned');

      expect((await h.bind(t.ctx, 0.5, { issueId })).decision.outcome).toBe('allow');
    });

    it('keeps a charge that is younger than the TTL, one that was consumed, and one a run references', async () => {
      const t = await h.newTenant();
      await h.setLimit(t.ctx, { spendLimit: 100 });
      const young = await h.bind(t.ctx, 1);
      const consumed = await h.bind(t.ctx, 1);
      await h.prisma.policyDecision.update({
        where: { id: consumed.decision.id },
        data: { consumedAt: new Date() },
      });
      const started = await h.bind(t.ctx, 1);
      await seedAgentRun(h.pg, {
        tenantId: t.tenantId,
        cost: 0,
        finishedAt: null,
        policyDecisionId: started.decision.id,
        startedAt: NOON.toISOString(),
      });

      // young: evaluated at NOON, released only for charges older than now - TTL
      expect(
        await releaseAbandonedCharges(h.budgets, t.ctx, { now: new Date(NOON.getTime() + 1_000) }),
      ).toBe(0);
      const much = new Date(NOON.getTime() + 24 * 3_600_000);
      expect(await releaseAbandonedCharges(h.budgets, t.ctx, { now: much })).toBe(1); // only `young`
      const rows = await h.prisma.policyDecision.findMany({
        where: { id: { in: [young.decision.id, consumed.decision.id, started.decision.id] } },
      });
      const reasonOf = (id: string) => rows.find((r) => r.id === id)?.invalidatedReason;
      expect(reasonOf(young.decision.id)).toBe('charge_abandoned');
      expect(reasonOf(consumed.decision.id)).toBeNull();
      expect(reasonOf(started.decision.id)).toBeNull();
    });

    it("never releases another tenant's charge", async () => {
      const a = await h.newTenant();
      const b = await h.newTenant();
      await h.setLimit(b.ctx, { spendLimit: 100 });
      const theirs = await h.bind(b.ctx, 1);
      await releaseAbandonedCharges(h.budgets, a.ctx, {
        now: new Date(NOON.getTime() + 24 * 3_600_000),
      });
      const row = await h.prisma.policyDecision.findUnique({ where: { id: theirs.decision.id } });
      expect(row?.invalidatedReason).toBeNull();
    });
  });

  describe('time counts active run time only (H1)', () => {
    it('a run parked awaiting approval for longer than the limit does not exhaust the time budget', async () => {
      const t = await h.newTenant();
      await h.setLimit(t.ctx, {
        scopeType: 'issue',
        period: 'issue',
        spendLimit: 50,
        timeLimitMs: 3_600_000,
      });
      const issueId = await seedIssue(h.pg, t.tenantId);
      const run = await seedWorkflowRun(h.pg, {
        tenantId: t.tenantId,
        issueId,
        startedAt: '2026-10-01T10:00:00Z',
      });
      await seedTransition(h.pg, t.tenantId, run.id, 'awaiting_approval', '2026-10-01T10:05:00Z');
      const asOf = new Date('2026-10-02T10:00:00Z'); // parked for ~24 h, limit 1 h
      const issueScope = (b: Awaited<ReturnType<BudgetHarness['resolve']>>) =>
        b.scopes.find((s) => s.scopeType === 'issue')!;
      expect(issueScope(await h.resolve(t.ctx, { issueId }, asOf)).timeConsumedMs).toBe(5 * 60_000);
    });

    it('the same run charged for the wait would have exhausted it — the control', async () => {
      const t = await h.newTenant();
      const issueId = await seedIssue(h.pg, t.tenantId);
      const run = await seedWorkflowRun(h.pg, {
        tenantId: t.tenantId,
        issueId,
        startedAt: '2026-10-01T10:00:00Z',
      });
      await seedTransition(h.pg, t.tenantId, run.id, 'executing', '2026-10-01T10:05:00Z'); // not a wait
      const b = await h.resolve(t.ctx, { issueId }, new Date('2026-10-02T10:00:00Z'));
      expect(b.scopes.find((s) => s.scopeType === 'issue')!.timeConsumedMs).toBe(24 * 3_600_000);
    });

    it('active time resumes after the wait: parked 10:05 to 11:00, live until 11:30, is 5 + 30 minutes', async () => {
      const t = await h.newTenant();
      const issueId = await seedIssue(h.pg, t.tenantId);
      const run = await seedWorkflowRun(h.pg, {
        tenantId: t.tenantId,
        issueId,
        startedAt: '2026-10-02T10:00:00Z',
      });
      await seedTransition(h.pg, t.tenantId, run.id, 'awaiting_ci', '2026-10-02T10:05:00Z');
      await seedTransition(h.pg, t.tenantId, run.id, 'executing', '2026-10-02T11:00:00Z');
      const b = await h.resolve(t.ctx, { issueId }, new Date('2026-10-02T11:30:00Z'));
      expect(b.scopes.find((s) => s.scopeType === 'issue')!.timeConsumedMs).toBe(35 * 60_000);
    });
  });

  describe('the lock wait is bounded (I2/#12)', () => {
    it('a charge that cannot take the lock inside the bound fails retryably instead of queueing', async () => {
      const t = await h.newTenant();
      await h.setLimit(t.ctx, { spendLimit: 10 });
      const holder = await hold(h.prisma, async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${budgetLockKey(t.tenantId)}, 0))`;
      });
      try {
        const started = Date.now();
        const pending = h.bind(t.ctx, 1);
        await waitForBlocked(h.pg, 1, holder);
        await expect(pending).rejects.toThrow(BudgetContentionError);
        expect(Date.now() - started).toBeLessThan(BUDGET_LOCK_WAIT_MS + 5_000);
      } finally {
        await holder.release();
      }
      // and the lock is usable again, with nothing half-charged
      expect(await decisionCount(t.tenantId)).toBe(0);
      expect((await h.bind(t.ctx, 1)).decision.outcome).toBe('allow');
    }, 60_000);
  });

  describe('dry run and enforcing path agree (I4, R-08)', () => {
    it('an over-budget issue is DENY on the dry run and when enforcing', async () => {
      const t = await h.newTenant();
      await h.setLimit(t.ctx, { scopeType: 'issue', period: 'issue', spendLimit: 1 });
      const issueId = await seedIssue(h.pg, t.tenantId);
      await seedAgentRun(h.pg, { tenantId: t.tenantId, issueId, cost: 1 });

      const dry = await explainDecision(
        {
          rulesets: h.rulesets,
          actions: h.repos.actions,
          autonomyGrants: h.repos.autonomyGrants,
          budgets: h.budgets,
        },
        t.ctx,
        { decisionInput: decisionInput(0.1, NOON), binding: { issueId } },
      );
      const enforced = await h.bind(t.ctx, 0.1, { issueId });
      expect(dry.decision.outcome).toBe('deny');
      expect(enforced.decision.outcome).toBe('deny');
      expect(dry.decision.reasonCodes).toEqual(enforced.decision.reasonCodes);
    });
  });

  describe('configuration that was replaced is surfaced, not silent (#5)', () => {
    it('an unknown degradation entry and an out-of-range threshold in 012 tenant_budget come back as warnings and are logged', async () => {
      const logged: Record<string, unknown>[] = [];
      const budgets = new PrismaBudgetRepository(h.prisma, {
        maxEvaluationSkewMs: Number.POSITIVE_INFINITY,
        log: { warn: (fields) => void logged.push(fields) },
      });
      const t = await h.newTenant();
      await query(
        h.pg,
        `insert into "tenant"."tenant_budget"
           (tenant_id, period, spend_limit, time_limit, soft_threshold_pcts, degradation_order, updated_at)
         values ('${t.tenantId}', 'day', 10, 86400000, '{50,150}', '{cheaper_tier,rm_rf}', now())`,
      );
      const b = await budgets.resolve(scope(t.ctx, { asOf: NOON }));
      expect(b.warnings).toHaveLength(2);
      expect(b.degradationOrder).toEqual(['cheaper_tier', 'reduced_context', 'diagnosis_only']);
      expect(logged.map((l) => l['tenantId'])).toEqual([t.tenantId, t.tenantId]);
    });
  });

  describe('issue deletion (#8)', () => {
    it('removes the issue-scope marks and the marks whose evidence went with it, so the step is recorded afresh', async () => {
      const t = await h.newTenant();
      await h.setLimit(t.ctx, { spendLimit: 10 });
      await h.setLimit(t.ctx, { scopeType: 'issue', period: 'issue', spendLimit: 50 });
      const doomed = await seedIssue(h.pg, t.tenantId);
      const survivor = await seedIssue(h.pg, t.tenantId);
      await seedAgentRun(h.pg, {
        tenantId: t.tenantId,
        cost: 6,
        startedAt: '2026-10-02T10:00:00Z',
      });

      await h.bind(t.ctx, 0.1, { issueId: doomed }); // records the tenant-day step 1 on `doomed`
      expect(await h.prisma.budgetDegradationMark.count({ where: { tenantId: t.tenantId } })).toBe(
        1,
      );

      await withCorrelation(randomUUID(), () =>
        deleteIssue(issueDeletion(), t.ctx, { id: doomed, requestedBy: 'pavlo', reason: 'gdpr' }),
      );
      expect(await h.prisma.budgetDegradationMark.count({ where: { tenantId: t.tenantId } })).toBe(
        0,
      );

      await h.bind(t.ctx, 0.1, { issueId: survivor }); // the step is derived: recorded again
      const evidence = await h.prisma.evidence.findMany({
        where: { tenantId: t.tenantId, type: 'budget_degradation' },
      });
      expect(evidence.map((e) => e.issueId)).toEqual([survivor]);
    });
  });

  describe('a truncated completed-run list says so (#15)', () => {
    it('flags completedAgentRunsTruncated past the cap', async () => {
      const t = await h.newTenant();
      await h.setLimit(t.ctx, { scopeType: 'issue', period: 'issue', spendLimit: 1 });
      const issueId = await seedIssue(h.pg, t.tenantId);
      await seedAgentRun(h.pg, { tenantId: t.tenantId, issueId, cost: 1 });
      for (let i = 0; i < 50; i += 1)
        await seedAgentRun(h.pg, { tenantId: t.tenantId, issueId, cost: 0.0001 });
      await h.bind(t.ctx, 0.1, { issueId });
      const last = (
        await h.prisma.evidence.findMany({
          where: { tenantId: t.tenantId, type: 'budget_degradation' },
          orderBy: { receivedAt: 'asc' },
        })
      ).at(-1)!;
      const payload = last.payload as Record<string, unknown>;
      expect(payload['completedAgentRunsTruncated']).toBe(true);
      expect(payload['completedAgentRuns']).toHaveLength(50);
    });
  });
});
