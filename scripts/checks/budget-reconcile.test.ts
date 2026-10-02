import { describe, expect, it } from 'vitest';
import { findUnmeasuredCostRuns, recompute } from './budget-reconcile.mjs';

// `check:budget-reconcile` (002 T069, R-10): the budget aggregate is SQL; this is the same
// definition recomputed in JS from the raw rows, so a disagreement between the two is a bug in one
// of them rather than a number nobody can explain. These tests pin the JS side.

const T = '00000000-0000-0000-8000-0000000000a1';
const iso = (s: string) => new Date(s);

const base = { runs: [], workflowRuns: [], decisions: [] };

describe('recompute — spend', () => {
  it('buckets finished agent_run cost by the UTC day and month of its pinned start', () => {
    const { tenant } = recompute(
      {
        ...base,
        runs: [
          {
            tenantId: T,
            issueId: null,
            correlationId: 'c1',
            cost: 1.5,
            startedAt: iso('2026-10-02T10:00:00Z'),
            policyDecisionId: null,
          },
          {
            tenantId: T,
            issueId: null,
            correlationId: 'c2',
            cost: 2,
            startedAt: iso('2026-10-03T00:00:00Z'),
            policyDecisionId: null,
          },
        ],
      },
      iso('2026-10-04T00:00:00Z'),
    );
    expect(tenant.get(`${T}|day|2026-10-02`)?.spend).toBe(1.5);
    expect(tenant.get(`${T}|day|2026-10-03`)?.spend).toBe(2);
    expect(tenant.get(`${T}|month|2026-10`)?.spend).toBe(3.5);
  });

  it("an agent run is pinned to its workflow run's start, not its own (T061)", () => {
    const { tenant } = recompute(
      {
        ...base,
        workflowRuns: [
          {
            tenantId: T,
            id: 'w1',
            issueId: 'i1',
            correlationId: 'c1',
            startedAt: iso('2026-10-02T23:55:00Z'),
            updatedAt: iso('2026-10-03T00:30:00Z'),
            terminal: true,
          },
        ],
        runs: [
          {
            tenantId: T,
            issueId: 'i1',
            correlationId: 'c1',
            cost: 1,
            startedAt: iso('2026-10-03T00:10:00Z'),
            policyDecisionId: null,
          },
        ],
      },
      iso('2026-10-04T00:00:00Z'),
    );
    expect(tenant.get(`${T}|day|2026-10-02`)?.spend).toBe(1);
    expect(tenant.get(`${T}|day|2026-10-03`)?.spend ?? 0).toBe(0);
  });

  it('a run that predates its workflow keeps its own earlier window — it was not requested by that workflow', () => {
    const { tenant } = recompute(
      {
        ...base,
        workflowRuns: [
          {
            tenantId: T,
            id: 'w1',
            issueId: 'i1',
            correlationId: 'c1',
            startedAt: iso('2026-10-02T00:20:00Z'),
            updatedAt: iso('2026-10-02T01:00:00Z'),
            terminal: true,
          },
        ],
        runs: [
          {
            tenantId: T,
            issueId: 'i1',
            correlationId: 'c1',
            cost: 0.5,
            startedAt: iso('2026-10-01T23:50:00Z'),
            policyDecisionId: null,
          },
        ],
      },
      iso('2026-10-04T00:00:00Z'),
    );
    expect(tenant.get(`${T}|day|2026-10-01`)?.spend).toBe(0.5);
    expect(tenant.get(`${T}|day|2026-10-02`)?.spend ?? 0).toBe(0);
  });

  it('an allowed step with no finished run yet is an open charge at its declared maximum; the finished run replaces it', () => {
    const decision = {
      tenantId: T,
      id: 'd1',
      issueId: 'i1',
      workflowRunId: null,
      evaluatedAt: iso('2026-10-02T11:00:00Z'),
      outcome: 'allow',
      invalidatedReason: null,
      reservedSpend: 2,
    };
    const open = recompute({ ...base, decisions: [decision] }, iso('2026-10-04T00:00:00Z'));
    expect(open.tenant.get(`${T}|day|2026-10-02`)?.spend).toBe(2);
    expect(open.issue.get(`${T}|i1`)?.spend).toBe(2);

    const landed = recompute(
      {
        ...base,
        decisions: [decision],
        runs: [
          {
            tenantId: T,
            issueId: 'i1',
            correlationId: 'c9',
            cost: 1.5,
            startedAt: iso('2026-10-02T11:30:00Z'),
            policyDecisionId: 'd1',
            finishedAt: iso('2026-10-02T11:31:00Z'),
          },
        ],
      },
      iso('2026-10-04T00:00:00Z'),
    );
    expect(landed.tenant.get(`${T}|day|2026-10-02`)?.spend).toBe(1.5);
  });

  it('a denied or invalidated decision charges nothing', () => {
    const d = {
      tenantId: T,
      id: 'd',
      issueId: null,
      workflowRunId: null,
      evaluatedAt: iso('2026-10-02T11:00:00Z'),
      reservedSpend: 5,
    };
    const r = recompute(
      {
        ...base,
        decisions: [
          { ...d, outcome: 'deny', invalidatedReason: null },
          { ...d, id: 'e', outcome: 'allow', invalidatedReason: 'epoch_bump' },
        ],
      },
      iso('2026-10-04T00:00:00Z'),
    );
    expect(r.tenant.get(`${T}|day|2026-10-02`)?.spend ?? 0).toBe(0);
  });
});

describe('recompute — time', () => {
  it('a terminal run counts to its last update, a live one to the check instant, never negative', () => {
    const { tenant, issue } = recompute(
      {
        ...base,
        workflowRuns: [
          {
            tenantId: T,
            id: 'w1',
            issueId: 'i1',
            correlationId: 'c1',
            startedAt: iso('2026-10-02T10:00:00Z'),
            updatedAt: iso('2026-10-02T10:30:00Z'),
            terminal: true,
          },
          {
            tenantId: T,
            id: 'w2',
            issueId: 'i1',
            correlationId: 'c2',
            startedAt: iso('2026-10-02T11:00:00Z'),
            updatedAt: iso('2026-10-02T11:00:00Z'),
            terminal: false,
          },
          {
            tenantId: T,
            id: 'w3',
            issueId: 'i2',
            correlationId: 'c3',
            startedAt: iso('2026-10-05T00:00:00Z'),
            updatedAt: iso('2026-10-05T00:00:00Z'),
            terminal: false,
          },
        ],
      },
      iso('2026-10-02T11:10:00Z'),
    );
    expect(tenant.get(`${T}|day|2026-10-02`)?.timeMs).toBe(1_800_000 + 600_000);
    expect(issue.get(`${T}|i1`)?.timeMs).toBe(2_400_000);
    expect(issue.get(`${T}|i2`)?.timeMs).toBe(0); // started after the check instant: clamped, not negative
  });
});

describe('findUnmeasuredCostRuns — fail loudly rather than pass on an estimate', () => {
  const run = (over: object) => ({
    id: 'r1',
    tenantId: T,
    cost: 0.05,
    inputTokens: 100,
    outputTokens: 50,
    finished: true,
    declaredMax: null,
    ...over,
  });

  it('a finished run that recorded tokens but no cost is unpriced — nothing measured it', () => {
    const v = findUnmeasuredCostRuns([run({ cost: 0 })]);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/r1/);
    expect(v[0]).toMatch(/tokens/);
  });

  it('a negative cost is not a measurement', () => {
    expect(findUnmeasuredCostRuns([run({ cost: -1 })])).toHaveLength(1);
  });

  it('a run that cost more than the maximum its step declared broke the ex-ante guarantee (R-11)', () => {
    const v = findUnmeasuredCostRuns([run({ cost: 3, declaredMax: 2 })]);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/declared/);
  });

  it('a priced run within its declared maximum, and a run still in flight, are fine', () => {
    expect(findUnmeasuredCostRuns([run({}), run({ cost: 0, finished: false })])).toEqual([]);
    expect(findUnmeasuredCostRuns([run({ cost: 2, declaredMax: 2 })])).toEqual([]);
  });

  it('a run with no tokens and no cost is not accused of being unpriced', () => {
    expect(findUnmeasuredCostRuns([run({ cost: 0, inputTokens: 0, outputTokens: 0 })])).toEqual([]);
  });
});
