import { describe, expect, it } from 'vitest';
import type { WorkflowRun } from './machine.js';
import { findOverdueRuns, findStuckRuns } from './periodic-checks.js';

function run(overrides: Partial<WorkflowRun>): WorkflowRun {
  return {
    id: 'r1',
    tenantId: 't1',
    issueId: 'i1',
    definitionKey: 'd1',
    definitionVersion: 1,
    state: 's1',
    correlationId: 'c1',
    startedAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('findOverdueRuns (012 T056, FR-025, quickstart 26)', () => {
  const now = new Date('2026-01-02T00:00:00Z');

  it('finds a non-terminal run whose deadline has passed — the callback that never arrived', () => {
    const overdue = run({ deadlineAt: new Date('2026-01-01T12:00:00Z') });
    expect(findOverdueRuns([overdue], now)).toEqual([overdue]);
  });

  it('does not report a run whose deadline is still in the future', () => {
    const notYet = run({ deadlineAt: new Date('2026-01-03T00:00:00Z') });
    expect(findOverdueRuns([notYet], now)).toEqual([]);
  });

  it('does not report a terminal run even with a stale deadline', () => {
    const done = run({ deadlineAt: new Date('2026-01-01T00:00:00Z'), terminalState: 's1' });
    expect(findOverdueRuns([done], now)).toEqual([]);
  });

  it('does not report a run with no deadline at all', () => {
    expect(findOverdueRuns([run({})], now)).toEqual([]);
  });
});

describe('findStuckRuns (012 T058, data-model invariant, quickstart 26)', () => {
  it('reports a non-terminal run with neither a pending callback nor a deadline', () => {
    const stuck = run({});
    expect(findStuckRuns([stuck])).toEqual([stuck]);
  });

  it('does not report a run with a deadline', () => {
    expect(findStuckRuns([run({ deadlineAt: new Date('2026-02-01T00:00:00Z') })])).toEqual([]);
  });

  it('does not report a terminal run', () => {
    expect(findStuckRuns([run({ terminalState: 's1' })])).toEqual([]);
  });
});
