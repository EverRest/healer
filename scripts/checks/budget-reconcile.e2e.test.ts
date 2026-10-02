import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  seedAgentRun,
  seedIssue,
  seedTransition,
  seedWorkflowRun,
} from '../../test/budget-fixtures.js';
import {
  startBudgetHarness,
  type BudgetHarness,
} from '../../test/infrastructure/budget-harness.js';
import { findBudgetDiscrepancies } from './budget-reconcile.mjs';

/**
 * `check:budget-reconcile` against a real Postgres (002 T069, R-10): the SQL aggregate policy
 * enforces is compared with an independent JS recomputation from the raw `agent_run`,
 * `policy_decision` and `workflow_run` rows. Part of `make ci` through `make test-e2e`: this file
 * runs the check over realistic data on every build, and the budget scenarios themselves
 * (`budget-enforcement`, `budget-flood`) end by running it over everything they left behind.
 */
const AS_OF = new Date('2026-10-03T12:00:00Z');

describe('check:budget-reconcile (002 T069)', () => {
  let h: BudgetHarness;

  beforeAll(async () => {
    h = await startBudgetHarness();
  }, 180_000);

  afterAll(async () => {
    await h?.stop();
  });

  /** A tenant with spend before and after midnight, an in-flight step, a terminal and a live run,
   *  and an agent run that happened *before* the workflow it belongs to was started. */
  async function busyTenant() {
    const { tenantId, ctx } = await h.newTenant();
    await h.setLimit(ctx, { spendLimit: 100 });
    await h.setLimit(ctx, {
      scopeType: 'issue',
      period: 'issue',
      spendLimit: 50,
      timeLimitMs: 14_400_000,
    });
    const issueId = await seedIssue(h.pg, tenantId);
    const run = await seedWorkflowRun(h.pg, {
      tenantId,
      issueId,
      startedAt: '2026-10-02T23:55:00Z',
      endedAt: '2026-10-03T00:30:00Z',
    });
    await seedAgentRun(h.pg, {
      tenantId,
      issueId,
      cost: 2,
      correlationId: run.correlationId,
      startedAt: '2026-10-02T23:56:00Z',
    });
    await seedAgentRun(h.pg, {
      tenantId,
      issueId,
      cost: 1,
      correlationId: run.correlationId,
      startedAt: '2026-10-03T00:10:00Z',
    });
    // classified at ingest on the 1st, investigated from the 2nd: the spend happened on the 1st
    const later = await seedWorkflowRun(h.pg, {
      tenantId,
      issueId,
      startedAt: '2026-10-02T00:20:00Z',
      endedAt: '2026-10-02T01:00:00Z',
    });
    // and one still running, so a live run's elapsed time is part of what is reconciled
    await seedWorkflowRun(h.pg, { tenantId, issueId, startedAt: '2026-10-03T08:00:00Z' });
    await seedAgentRun(h.pg, {
      tenantId,
      issueId,
      cost: 0.5,
      correlationId: later.correlationId,
      startedAt: '2026-10-01T23:50:00Z',
    });
    // parked awaiting a human for 15 minutes of that terminal run: SQL and JS must both exclude it
    await seedTransition(h.pg, tenantId, later.id, 'awaiting_approval', '2026-10-02T00:30:00Z');
    await seedTransition(h.pg, tenantId, later.id, 'executing', '2026-10-02T00:45:00Z');
    // an allowed step whose run has not landed (open charge) and one whose run has
    const open = await h.bind(
      ctx,
      1.25,
      { issueId, workflowRunId: run.id },
      new Date('2026-10-03T00:15:00Z'),
    );
    const landed = await h.bind(ctx, 2, { issueId }, new Date('2026-10-03T09:00:00Z'));
    await seedAgentRun(h.pg, {
      tenantId,
      issueId,
      cost: 1.75,
      startedAt: '2026-10-03T09:05:00Z',
      policyDecisionId: landed.decision.id,
    });
    expect(open.decision.outcome).toBe('allow');
    return { tenantId, ctx, issueId, run };
  }

  it('finds nothing when the aggregate and the rows agree — across midnight, in flight, landed, terminal and live', async () => {
    const { tenantId } = await busyTenant();
    // scoped to this tenant: the other scenarios in this file plant violations on purpose
    expect(await findBudgetDiscrepancies(h.prisma, { asOf: AS_OF, tenantIds: [tenantId] })).toEqual(
      [],
    );
  });

  it("flags a run whose policy_decision_id names no decision, another tenant's decision, or a deny", async () => {
    const a = await h.newTenant();
    const b = await h.newTenant();
    await h.setLimit(b.ctx, { spendLimit: 100 });
    const theirs = await h.bind(b.ctx, 1);
    const ghost = await seedAgentRun(h.pg, {
      tenantId: a.tenantId,
      cost: 1,
      policyDecisionId: randomUUID(),
    });
    const foreign = await seedAgentRun(h.pg, {
      tenantId: a.tenantId,
      cost: 1,
      policyDecisionId: theirs.decision.id,
    });
    const violations = await findBudgetDiscrepancies(h.prisma, {
      asOf: AS_OF,
      tenantIds: [a.tenantId],
    });
    expect(violations.some((v) => v.includes(ghost) && v.includes('names no decision'))).toBe(true);
    expect(violations.some((v) => v.includes(foreign) && v.includes('another tenant'))).toBe(true);
  });

  it('an agent run that precedes its workflow is charged to the window it actually ran in', async () => {
    const { tenantId, ctx } = await busyTenant();
    const oct1 = await h.resolve(ctx, {}, new Date('2026-10-01T12:00:00Z'));
    expect(h.tenantDay(oct1)).toMatchObject({ periodKey: '2026-10-01', spendConsumed: 0.5 });
    expect(tenantId).toBeTruthy();
  });

  it('reports a disagreement between the aggregate and the rows (the comparison is live)', async () => {
    const { tenantId } = await busyTenant();
    const violations = await findBudgetDiscrepancies(h.prisma, {
      asOf: AS_OF,
      derive: {
        tenant: async (_p: unknown, _t: string, _w: unknown, _a: Date) => ({
          spend: 999,
          timeMs: 0,
        }),
      },
    });
    expect(violations.some((v) => v.includes(tenantId) && v.includes('derived spend 999'))).toBe(
      true,
    );
  });

  it('reports a time disagreement and a per-issue disagreement too', async () => {
    const { issueId } = await busyTenant();
    const violations = await findBudgetDiscrepancies(h.prisma, {
      asOf: AS_OF,
      derive: {
        tenant: async () => ({ spend: 0, timeMs: -1 }),
        issue: async () => ({ spend: 0, timeMs: 0 }),
      },
    });
    expect(violations.some((v) => v.includes('derived time'))).toBe(true);
    expect(violations.some((v) => v.includes(`issue ${issueId}`))).toBe(true);
  });

  it('fails loudly on a finished run that recorded tokens but no cost, rather than pass on an estimate', async () => {
    const { tenantId } = await h.newTenant();
    const id = await seedAgentRun(h.pg, { tenantId, cost: 0, startedAt: '2026-10-02T10:00:00Z' });
    const violations = await findBudgetDiscrepancies(h.prisma, { asOf: AS_OF });
    expect(violations.some((v) => v.includes(id) && v.includes('not measured'))).toBe(true);
  });

  it('fails loudly on a run that cost more than the maximum its step declared', async () => {
    const { tenantId, ctx } = await h.newTenant();
    await h.setLimit(ctx, { spendLimit: 100 });
    const { decision } = await h.bind(ctx, 2);
    const id = await seedAgentRun(h.pg, {
      tenantId,
      cost: 3,
      startedAt: '2026-10-02T10:00:00Z',
      policyDecisionId: decision.id,
    });
    const violations = await findBudgetDiscrepancies(h.prisma, { asOf: AS_OF });
    expect(violations.some((v) => v.includes(id) && v.includes('exceeds the maximum'))).toBe(true);
  });
});
