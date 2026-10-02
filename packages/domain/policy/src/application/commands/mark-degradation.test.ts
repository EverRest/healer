import { describe, expect, it } from 'vitest';
import { TenantContext, type TenantScoped } from '@healer/shared';
import type { ScopeFigures } from '../../domain/budget-figures.js';
import type {
  MarkDegradationInput,
  MarkDegradationResult,
  ResolvedBudget,
} from '../../domain/budget-repository.js';
import { DEGRADATION_ORDER } from '../../domain/degradation.js';
import { markDegradation } from './mark-degradation.js';

// T064 (FR-012, R-12): each first advance to a step is recorded once, in order, naming the entry
// applied from the declared order. This unit proves the *loop*: which steps, in what order, with
// which entry and figures. The exactly-once guarantee under redelivery and races is the mark
// table's primary key, proven against Postgres in budget-degradation.e2e.test.ts.

const CONTEXT = TenantContext.forTrustedInternalUse('00000000-0000-0000-8000-0000000000a1');

const tenantDay = (spendConsumed: number): ScopeFigures => ({
  scopeType: 'tenant',
  scopeId: CONTEXT.tenantId,
  period: 'day',
  periodKey: '2026-10-02',
  spendConsumed,
  spendLimit: 100,
  timeConsumedMs: 0,
  timeLimitMs: 1_000_000,
  softThresholdPcts: [50, 75, 90],
});

const budgetOf = (...scopes: ScopeFigures[]): ResolvedBudget => ({
  scopes,
  escalation: { attemptCount: 0, cap: 2 },
  degradationOrder: DEGRADATION_ORDER,
});

function recorder() {
  const calls: MarkDegradationInput[] = [];
  return {
    calls,
    repo: {
      async markDegradation(
        where: TenantScoped<MarkDegradationInput>,
      ): Promise<MarkDegradationResult> {
        calls.push(where);
        return { marked: true, evidenceId: `ev-${where.step}` };
      },
    },
  };
}

const run = (budget: ResolvedBudget, issueId: string | null = 'issue-1') =>
  markDegradation(rec.repo, CONTEXT, {
    budget,
    ...(issueId !== null ? { issueId } : {}),
    asOf: new Date('2026-10-02T12:00:00Z'),
  });
let rec = recorder();

describe('markDegradation', () => {
  it('writes nothing before the first soft threshold', async () => {
    rec = recorder();
    await run(budgetOf(tenantDay(49)));
    expect(rec.calls).toEqual([]);
  });

  it('applies the declared order in order, one step at a time', async () => {
    rec = recorder();
    await run(budgetOf(tenantDay(80)));
    expect(rec.calls.map((c) => [c.step, c.entryApplied])).toEqual([
      [1, 'cheaper_tier'],
      [2, 'reduced_context'],
    ]);
  });

  it('a single large charge that jumps over a step still records every step it passed', async () => {
    rec = recorder();
    await run(budgetOf(tenantDay(95)));
    expect(rec.calls.map((c) => c.step)).toEqual([1, 2, 3]);
    expect(rec.calls.at(-1)?.entryApplied).toBe('diagnosis_only');
  });

  it('exhaustion is the step after the last threshold and names the refusal, not a declared entry', async () => {
    rec = recorder();
    await run(budgetOf(tenantDay(100)));
    expect(rec.calls.map((c) => [c.step, c.entryApplied])).toEqual([
      [1, 'cheaper_tier'],
      [2, 'reduced_context'],
      [3, 'diagnosis_only'],
      [4, 'ai_steps_refused'],
    ]);
  });

  it('carries the consumed and limit figures, the scope and the pinned period key', async () => {
    rec = recorder();
    await run(budgetOf(tenantDay(60)));
    expect(rec.calls[0]).toMatchObject({
      scopeType: 'tenant',
      scopeId: CONTEXT.tenantId,
      periodKey: '2026-10-02',
      consumed: 60,
      limit: 100,
      dimension: 'spend',
      issueId: 'issue-1',
    });
  });

  it("uses the tenant's own declared order, and stays on the last entry past its end", async () => {
    rec = recorder();
    await run({ ...budgetOf(tenantDay(95)), degradationOrder: ['diagnosis_only'] });
    expect(rec.calls.map((c) => c.entryApplied)).toEqual([
      'diagnosis_only',
      'diagnosis_only',
      'diagnosis_only',
    ]);
  });

  it('records each scope on its own: the tenant day and the issue degrade independently', async () => {
    rec = recorder();
    const issue: ScopeFigures = {
      ...tenantDay(1),
      scopeType: 'issue',
      scopeId: 'issue-1',
      period: 'issue',
      periodKey: 'issue',
      spendLimit: 2,
    };
    await run(budgetOf(tenantDay(10), issue));
    expect(rec.calls.map((c) => [c.scopeType, c.step])).toEqual([['issue', 1]]);
  });

  it('with no issue to attach evidence to, records nothing rather than inventing one', async () => {
    rec = recorder();
    const results = await run(budgetOf(tenantDay(95)), null);
    expect(rec.calls).toEqual([]);
    expect(results).toEqual([]);
  });
});
