import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedIssues } from './test/budget-fixtures.js';
import { findBudgetDiscrepancies } from './scripts/checks/budget-reconcile.mjs';
import { startBudgetHarness, type BudgetHarness } from './test/infrastructure/budget-harness.js';

/**
 * 002 T065 (FR-012, SC-006, quickstart 26): a misconfigured alert rule fires four hundred times
 * overnight. The tenant's budget absorbs the first portion, degrades **in the declared order** —
 * one evidence record per step — and then stops; tenant spend never leaves the period budget.
 *
 * Genuinely heavy (400 serialized charges against a real Postgres), so it runs in its own
 * `HEAVY_E2E` group rather than alongside the rest of the suite.
 */
describe('400-issue flood (002 T065, SC-006)', () => {
  const FLOOD = 400;
  const DECLARED = 0.25; // exactly representable, so 80 charges land exactly on the limit of 20
  const LIMIT = 20;
  let h: BudgetHarness;

  beforeAll(async () => {
    h = await startBudgetHarness();
  }, 180_000);

  afterAll(async () => {
    await h?.stop();
  });

  it('applies the declared order in order, one evidence record per step, and spend stays inside the period budget', async () => {
    const { tenantId, ctx } = await h.newTenant();
    await h.setLimit(ctx, { spendLimit: LIMIT });
    const issues = await seedIssues(h.pg, tenantId, FLOOD);
    expect(issues).toHaveLength(FLOOD);

    // Bounded concurrency: the point is overlapping charges, not exhausting the connection pool.
    const outcomes: string[] = [];
    const WIDTH = 8;
    for (let i = 0; i < issues.length; i += WIDTH) {
      const batch = await Promise.all(
        issues.slice(i, i + WIDTH).map((issueId) => h.bind(ctx, DECLARED, { issueId })),
      );
      outcomes.push(...batch.map((r) => r.decision.outcome));
    }

    // Spend stayed inside the period budget: exactly the charges that fit were allowed.
    const allowed = outcomes.filter((o) => o === 'allow').length;
    expect(allowed).toBe(LIMIT / DECLARED);
    expect(outcomes.filter((o) => o === 'deny')).toHaveLength(FLOOD - allowed);

    const [totals] = await h.prisma.$queryRaw<{ reserved: number; worst: number }[]>`
      SELECT COALESCE(SUM((budget_state->>'reservedSpend')::numeric)
                        FILTER (WHERE outcome = 'allow'), 0)::float8 AS reserved,
             COALESCE(MAX((budget_state->>'consumed')::numeric
                          + (budget_state->>'declaredMaxCost')::numeric)
                        FILTER (WHERE outcome = 'allow'), 0)::float8 AS worst
      FROM "policy"."policy_decision" WHERE tenant_id = ${tenantId}::uuid`;
    expect(totals?.reserved).toBe(LIMIT);
    expect(totals?.worst).toBeLessThanOrEqual(LIMIT); // no allowed step ever saw itself cross

    // Degradation applied in the declared order — one evidence record per step, no more.
    const marks = await h.prisma.budgetDegradationMark.findMany({
      where: { tenantId },
      orderBy: { markedAt: 'asc' },
    });
    expect(marks.map((m) => m.step)).toEqual([1, 2, 3, 4]);
    const evidence = await h.prisma.evidence.findMany({
      where: { tenantId, type: 'budget_degradation' },
    });
    expect(evidence).toHaveLength(4);
    const byId = new Map(evidence.map((e) => [e.id, e.payload as Record<string, unknown>]));
    expect(marks.map((m) => byId.get(m.evidenceId)?.['entryApplied'])).toEqual([
      'cheaper_tier',
      'reduced_context',
      'diagnosis_only',
      'ai_steps_refused',
    ]);

    // …and the product said so on the bus exactly once per step.
    expect(await h.prisma.outbox.count({ where: { tenantId, name: 'BudgetDegraded' } })).toBe(3);
    expect(await h.prisma.outbox.count({ where: { tenantId, name: 'BudgetExhausted' } })).toBe(1);

    // The reader (T069): the 400 charges left the aggregate and the rows in agreement.
    expect(await findBudgetDiscrepancies(h.prisma)).toEqual([]);
  }, 300_000);
});
