import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  degradationEvidenceId,
  MARK_DEGRADATION_STEP,
  type MarkDegradationInput,
} from '@healer/domain-policy';
import { scope, withCorrelation } from '@healer/shared';
import { query } from './test/containers.js';
import { hold, seedAgentRun, seedIssue, waitForBlocked } from './test/budget-fixtures.js';
import {
  NOON,
  startBudgetHarness,
  type BudgetHarness,
} from './test/infrastructure/budget-harness.js';

/**
 * 002 T064 (FR-012, R-12) against a real Postgres: each *first* advance to a degradation step
 * writes exactly one `budget_degradation` evidence record naming the step, the entry applied from
 * the declared order, the consumed and limit figures and the period key. The evidence record is the
 * deliverable; `budget_degradation_mark` is only its idempotency key, and the race it guards is
 * proven with a transaction held open and polled through `pg_stat_activity`.
 */
describe('budget degradation evidence (002 T064)', () => {
  let h: BudgetHarness;

  beforeAll(async () => {
    h = await startBudgetHarness();
  }, 180_000);

  afterAll(async () => {
    await h?.stop();
  });

  /** A tenant whose day limit is 10 and whose per-issue limit is out of the way, with one issue. */
  async function degradingTenant() {
    const { tenantId, ctx } = await h.newTenant();
    await h.setLimit(ctx, { spendLimit: 10 });
    await h.setLimit(ctx, { scopeType: 'issue', period: 'issue', spendLimit: 50 });
    const issueId = await seedIssue(h.pg, tenantId);
    return { tenantId, ctx, issueId };
  }

  const evidenceOf = (tenantId: string) =>
    h.prisma.evidence.findMany({
      where: { tenantId, type: 'budget_degradation' },
      orderBy: { observedAt: 'asc' },
    });
  const marksOf = (tenantId: string) =>
    h.prisma.budgetDegradationMark.findMany({ where: { tenantId }, orderBy: { step: 'asc' } });
  const payloadOf = (e: { payload: unknown }) => e.payload as Record<string, unknown>;

  it('the first advance to a step writes one evidence record with the step, entry, figures and period key', async () => {
    const { tenantId, ctx, issueId } = await degradingTenant();
    await seedAgentRun(h.pg, { tenantId, cost: 6, startedAt: '2026-10-02T10:00:00Z' });

    await h.bind(ctx, 0.1, { issueId });

    const evidence = await evidenceOf(tenantId);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      issueId,
      type: 'budget_degradation',
      producedByStep: MARK_DEGRADATION_STEP,
      sourceSystem: 'healer.policy',
    });
    expect(payloadOf(evidence[0]!)).toMatchObject({
      scopeType: 'tenant',
      scopeId: tenantId,
      periodKey: '2026-10-02',
      step: 1,
      entryApplied: 'cheaper_tier',
      dimension: 'spend',
      consumed: 6,
      limit: 10,
    });
    const marks = await marksOf(tenantId);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({
      step: 1,
      periodKey: '2026-10-02',
      evidenceId: evidence[0]!.id,
    });
  });

  it('is idempotent: evaluating again at the same step records nothing more', async () => {
    const { tenantId, ctx, issueId } = await degradingTenant();
    await seedAgentRun(h.pg, { tenantId, cost: 6, startedAt: '2026-10-02T10:00:00Z' });
    await h.bind(ctx, 0.1, { issueId });
    await h.bind(ctx, 0.1, { issueId });
    await h.bind(ctx, 0.1, { issueId });
    expect(await evidenceOf(tenantId)).toHaveLength(1);
    expect(await marksOf(tenantId)).toHaveLength(1);
  });

  it('a jump over several steps records each of them, in order, naming the entries of the declared order', async () => {
    const { tenantId, ctx, issueId } = await degradingTenant();
    await seedAgentRun(h.pg, { tenantId, cost: 9.5, startedAt: '2026-10-02T10:00:00Z' });
    await h.bind(ctx, 0.1, { issueId });

    const evidence = await evidenceOf(tenantId);
    expect(evidence.map((e) => [payloadOf(e).step, payloadOf(e).entryApplied])).toEqual([
      [1, 'cheaper_tier'],
      [2, 'reduced_context'],
      [3, 'diagnosis_only'],
    ]);
    const marks = await marksOf(tenantId);
    expect(marks.map((m) => m.markedAt.getTime())).toEqual(
      [...marks.map((m) => m.markedAt.getTime())].sort((a, b) => a - b),
    );
  });

  it("names the entry from the tenant's own declared order (012 tenant_budget.degradation_order)", async () => {
    const { tenantId, ctx } = await h.newTenant();
    await query(
      h.pg,
      `insert into "tenant"."tenant_budget"
         (tenant_id, period, spend_limit, time_limit, soft_threshold_pcts, degradation_order, updated_at)
       values ('${tenantId}', 'day', 10, 86400000, '{50}', '{diagnosis_only,cheaper_tier}', now())`,
    );
    await h.setLimit(ctx, { scopeType: 'issue', period: 'issue', spendLimit: 50 });
    const issueId = await seedIssue(h.pg, tenantId);
    await seedAgentRun(h.pg, { tenantId, cost: 6, startedAt: '2026-10-02T10:00:00Z' });
    await h.bind(ctx, 0.1, { issueId });
    expect(payloadOf((await evidenceOf(tenantId))[0]!).entryApplied).toBe('diagnosis_only');
  });

  it('a refusal records exhaustion — once — and BudgetExhausted is published once', async () => {
    const { tenantId, ctx, issueId } = await degradingTenant();
    await seedAgentRun(h.pg, { tenantId, cost: 9, startedAt: '2026-10-02T10:00:00Z' });
    // 9 of 10 spent; declaring 2 is refused although consumption is still below the limit
    await h.bind(ctx, 2, { issueId });
    await h.bind(ctx, 2, { issueId });

    const steps = (await evidenceOf(tenantId)).map((e) => [
      payloadOf(e).step,
      payloadOf(e).entryApplied,
    ]);
    expect(steps).toEqual([
      [1, 'cheaper_tier'],
      [2, 'reduced_context'],
      [3, 'diagnosis_only'],
      [4, 'ai_steps_refused'],
    ]);
    const exhausted = await h.prisma.outbox.findMany({
      where: { tenantId, name: 'BudgetExhausted' },
    });
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]?.payload).toMatchObject({ scopeType: 'tenant', limit: 10 });
  });

  it('BudgetDegraded carries the evidenceId and no degradation text', async () => {
    const { tenantId, ctx, issueId } = await degradingTenant();
    await seedAgentRun(h.pg, { tenantId, cost: 6, startedAt: '2026-10-02T10:00:00Z' });
    await h.bind(ctx, 0.1, { issueId });

    const [evidence] = await evidenceOf(tenantId);
    const degraded = await h.prisma.outbox.findMany({
      where: { tenantId, name: 'BudgetDegraded' },
    });
    expect(degraded).toHaveLength(1);
    expect(degraded[0]?.payload).toEqual({
      scopeType: 'tenant',
      periodKey: '2026-10-02',
      step: 1,
      entryApplied: 'cheaper_tier',
      evidenceId: evidence!.id,
    });
    // the timeline's own feed hears of the record, as it does of any evidence
    const recorded = await h.prisma.outbox.findMany({
      where: { tenantId, name: 'EvidenceRecorded', subjectId: issueId },
    });
    expect(
      recorded.some((o) => (o.payload as { evidenceId?: string }).evidenceId === evidence!.id),
    ).toBe(true);
  });

  it('a per-issue exhaustion names the agent runs that completed (spec US4 scenario 1)', async () => {
    const { tenantId, ctx } = await h.newTenant();
    await h.setLimit(ctx, { scopeType: 'issue', period: 'issue', spendLimit: 1 });
    const issueId = await seedIssue(h.pg, tenantId);
    const done = await seedAgentRun(h.pg, { tenantId, issueId, cost: 1, outcome: 'diagnosed' });
    await h.bind(ctx, 0.1, { issueId });
    const last = (await evidenceOf(tenantId)).at(-1)!;
    expect(payloadOf(last)).toMatchObject({ scopeType: 'issue', entryApplied: 'ai_steps_refused' });
    expect(payloadOf(last).completedAgentRuns).toEqual([
      { agentRunId: done, agentKind: 'investigator', outcome: 'diagnosed' },
    ]);
  });

  describe('redelivery and races on the idempotency key', () => {
    const markInput = (
      tenantId: string,
      issueId: string,
      over: Partial<MarkDegradationInput> = {},
    ): MarkDegradationInput => ({
      scopeType: 'tenant',
      scopeId: tenantId,
      periodKey: '2026-10-02',
      step: 1,
      entryApplied: 'cheaper_tier',
      consumed: 6,
      limit: 10,
      dimension: 'spend',
      issueId,
      observedAt: NOON,
      ...over,
    });
    const mark = (ctx: Parameters<BudgetHarness['bind']>[0], input: MarkDegradationInput) =>
      withCorrelation(randomUUID(), () => h.budgets.markDegradation(scope(ctx, input)));

    it('at-least-once delivery: the same step delivered twice writes one record and says so', async () => {
      const { tenantId, ctx, issueId } = await degradingTenant();
      const first = await mark(ctx, markInput(tenantId, issueId));
      const second = await mark(ctx, markInput(tenantId, issueId));
      expect(first.marked).toBe(true);
      expect(second).toEqual({ marked: false, evidenceId: first.evidenceId });
      expect(await evidenceOf(tenantId)).toHaveLength(1);
    });

    it('a concurrent writer waits for the first to commit, then writes nothing', async () => {
      const { tenantId, ctx, issueId } = await degradingTenant();
      const evidenceId = degradationEvidenceId({
        tenantId,
        scopeType: 'tenant',
        scopeId: tenantId,
        periodKey: '2026-10-02',
        step: 1,
      });
      // Another delivery has claimed the step and has not committed yet.
      const holder = await hold(h.prisma, async (tx) => {
        await tx.$executeRaw`
          INSERT INTO "policy"."budget_degradation_mark"
            (tenant_id, scope_type, scope_id, period_key, step, evidence_id, marked_at)
          VALUES (${tenantId}::uuid, 'tenant', ${tenantId}::uuid, '2026-10-02', 1,
                  ${evidenceId}::uuid, now())`;
      });
      let settled = false;
      const pending = mark(ctx, markInput(tenantId, issueId)).finally(() => {
        settled = true;
      });
      await waitForBlocked(h.pg, 1, holder);
      expect(settled).toBe(false);

      await holder.release();
      expect(await pending).toEqual({ marked: false, evidenceId });
      expect(await evidenceOf(tenantId)).toHaveLength(0); // the claimant owns the write
    });

    it('if the first claimant rolls back, the waiting writer takes the step and records it', async () => {
      const { tenantId, ctx, issueId } = await degradingTenant();
      const holder = await hold(h.prisma, async (tx) => {
        await tx.$executeRaw`
          INSERT INTO "policy"."budget_degradation_mark"
            (tenant_id, scope_type, scope_id, period_key, step, evidence_id, marked_at)
          VALUES (${tenantId}::uuid, 'tenant', ${tenantId}::uuid, '2026-10-02', 1,
                  ${randomUUID()}::uuid, now())`;
      });
      const pending = mark(ctx, markInput(tenantId, issueId));
      await waitForBlocked(h.pg, 1, holder);
      await holder.rollback();
      expect((await pending).marked).toBe(true);
      expect(await evidenceOf(tenantId)).toHaveLength(1);
    });

    it('two scopes, two periods and two tenants never share a mark', async () => {
      const a = await degradingTenant();
      const b = await degradingTenant();
      const sameKey = (t: typeof a) => markInput(t.tenantId, t.issueId);
      await mark(a.ctx, sameKey(a));
      await mark(b.ctx, sameKey(b));
      await mark(a.ctx, { ...sameKey(a), periodKey: '2026-10-03' });
      expect(await evidenceOf(a.tenantId)).toHaveLength(2);
      expect(await evidenceOf(b.tenantId)).toHaveLength(1);
    });
  });
});
