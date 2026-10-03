import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluate, type ResolvedRuleset, type Rule } from '@healer/domain-policy';
import { query } from './test/containers.js';
import { decisionInput, seededPromptVersionId } from './test/budget-fixtures.js';
import {
  NOON,
  startBudgetHarness,
  type BudgetHarness,
} from './test/infrastructure/budget-harness.js';

/**
 * T080: the plan's performance goals (plan.md) — evaluation under 20 ms p95 excluding the budget
 * aggregate, the aggregate under 50 ms p95 at 10 000 agent runs per tenant-month. The measured
 * numbers are printed and recorded in tasks.md T080; the assertions are the plan's budgets.
 * Runs in its own heavy group (vitest.config.ts) — a latency number taken beside a dozen other
 * database containers measures the box, not the code.
 */
const percentile = (samples: number[], p: number) =>
  [...samples].sort((a, b) => a - b)[Math.ceil((p / 100) * samples.length) - 1]!;

async function timed(runs: number, fn: () => unknown): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    await fn();
    out.push(performance.now() - start);
  }
  return out;
}

describe('policy performance budget (plan.md)', () => {
  let h: BudgetHarness;
  beforeAll(async () => {
    h = await startBudgetHarness();
  }, 180_000);
  afterAll(async () => {
    await h?.stop();
  });

  it('evaluation (pure, 300 rules — "low hundreds" per tenant) is under 20 ms p95', async () => {
    // Every rule's predicate is evaluated; none match but the last, the slowest honest shape.
    const rules: Rule[] = Array.from({ length: 300 }, (_, i) => ({
      ruleKey: `rule-${i}`,
      predicates: [
        {
          kind: 'enumerated',
          field: 'action.actionClass',
          operator: 'equals',
          value: i === 299 ? 'code_change' : 'read_only',
        },
      ],
      outcome: 'allow',
      reasonCode: 'NO_ADOPTED_EXPECTATION',
    }));
    const ruleset: ResolvedRuleset = { version: 1, rules };
    const input = decisionInput(1, NOON);
    const samples = await timed(2_000, () => evaluate(ruleset, input));
    const p95 = percentile(samples, 95);
    process.stdout.write(`T080 evaluate p95 = ${p95.toFixed(3)} ms (300 rules, n=2000)\n`);
    expect(p95).toBeLessThan(20);
  });

  it('the budget aggregate at 10 000 agent runs per tenant-month is under 50 ms p95', async () => {
    const t = await h.newTenant();
    await h.setLimit(t.ctx, { spendLimit: 400 });
    await h.setLimit(t.ctx, { period: 'month', spendLimit: 400 });
    await query(
      h.pg,
      `insert into "agent"."agent_run"
         (id, tenant_id, correlation_id, agent_kind, prompt_version_id, model_id, provider,
          input_tokens, output_tokens, cost, tool_calls, outcome, started_at, finished_at)
       select gen_random_uuid(), '${t.tenantId}', gen_random_uuid(), 'investigator',
              '${seededPromptVersionId()}', 'claude-sonnet-5', 'anthropic', 100, 50, 0.01, '[]',
              'ok', '2026-10-01T00:00:00Z'::timestamptz + (g || ' seconds')::interval,
              '2026-10-01T00:00:00Z'::timestamptz + (g || ' seconds')::interval
       from generate_series(1, 10000) g`,
    );
    const samples = await timed(200, () => h.resolve(t.ctx));
    const p95 = percentile(samples, 95);
    // The month scope must actually have aggregated the 10 000 rows (10 000 × 0.01), or the
    // number above measures an empty query.
    const month = (await h.resolve(t.ctx)).scopes.find(
      (s) => s.scopeType === 'tenant' && s.period === 'month',
    );
    expect(month?.spendConsumed).toBeCloseTo(100, 6);
    process.stdout.write(
      `T080 budget aggregate p95 = ${p95.toFixed(2)} ms (10 000 agent runs, n=200)\n`,
    );
    expect(p95).toBeLessThan(50);
  });
});
