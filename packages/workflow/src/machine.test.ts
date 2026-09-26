import { describe, expect, it } from 'vitest';
import {
  InvalidTransitionError,
  WorkflowDefinitionError,
  compile,
  isStuck,
  start,
  step,
} from './machine.js';

const TENANT = '0193a1f0-0000-7000-8000-000000000001';
const ISSUE = '0193a1f0-0000-7000-8000-0000000000aa';
const CORR = '0193a1f0-0000-7000-8000-0000000000bb';

const definition = compile({
  key: 'investigation',
  version: 1,
  initial: 'collecting',
  states: [
    // Job-owned states carry the declared wall-clock budget that bounds them (R-02).
    { name: 'collecting', to: ['diagnosing', 'failed'], jobBudgetMs: 120_000 },
    { name: 'diagnosing', to: ['awaiting_ci', 'needs_human', 'failed'], jobBudgetMs: 300_000 },
    // A state that waits declares what it waits for and how long (ADR 0003).
    {
      name: 'awaiting_ci',
      to: ['done', 'needs_human'],
      awaits: { kind: 'ci_result', timeoutMs: 60_000 },
    },
    { name: 'needs_human', to: [], terminal: true },
    { name: 'done', to: [], terminal: true },
    { name: 'failed', to: [], terminal: true },
  ],
});

const begin = (now = new Date('2026-09-24T12:00:00Z')) =>
  start(definition, { tenantId: TENANT, issueId: ISSUE, correlationId: CORR, now });

describe('definition validation', () => {
  it('rejects a waiting state with no timeout — nothing would ever wake it', () => {
    expect(() =>
      compile({
        key: 'x',
        version: 1,
        initial: 'a',
        states: [{ name: 'a', to: [], awaits: { kind: 'ci_result', timeoutMs: 0 } }],
      }),
    ).toThrow(WorkflowDefinitionError);
  });

  it('rejects a non-terminal state with nothing to wake it and nothing to bound it', () => {
    expect(() =>
      compile({
        key: 'x',
        version: 1,
        initial: 'a',
        // Arrives from JSON, where the union could not be enforced by the compiler.
        states: JSON.parse('[{"name":"a","to":[]}]') as never,
      }),
    ).toThrow(WorkflowDefinitionError);
  });

  it('rejects a transition to a state that does not exist', () => {
    expect(() =>
      compile({
        key: 'x',
        version: 1,
        initial: 'a',
        states: [{ name: 'a', to: ['b'], jobBudgetMs: 1_000 }],
      }),
    ).toThrow(WorkflowDefinitionError);
  });

  it('rejects a terminal state that declares transitions', () => {
    expect(() =>
      compile({
        key: 'x',
        version: 1,
        initial: 'a',
        states: JSON.parse('[{"name":"a","to":["a"],"terminal":true}]') as never,
      }),
    ).toThrow(WorkflowDefinitionError);
  });
});

describe('run lifecycle', () => {
  it('pins the definition version at start, so a redeploy does not migrate a live run', () => {
    const { run } = begin();
    expect(run.definitionVersion).toBe(1);
    expect(run.state).toBe('collecting');
  });

  it('records a transition per step, with its cause', () => {
    const now = new Date('2026-09-24T12:00:00Z');
    const first = step(definition, begin(now).run, 'diagnosing', 'job', { now });
    expect(first.transition).toMatchObject({
      fromState: 'collecting',
      toState: 'diagnosing',
      cause: 'job',
    });
  });

  it('refuses a transition the definition does not declare', () => {
    expect(() => step(definition, begin().run, 'done', 'job')).toThrow(InvalidTransitionError);
  });

  it('never transitions a terminal run again', () => {
    const now = new Date('2026-09-24T12:00:00Z');
    const failed = step(definition, begin(now).run, 'failed', 'job', { now }).run;
    expect(failed.terminalState).toBe('failed');
    expect(() => step(definition, failed, 'diagnosing', 'job', { now })).toThrow(
      InvalidTransitionError,
    );
  });
});

describe('never wait inside a job', () => {
  const now = new Date('2026-09-24T12:00:00Z');

  it('gives a waiting state a deadline and what it waits for', () => {
    const diagnosing = step(definition, begin(now).run, 'diagnosing', 'job', { now }).run;
    const waiting = step(definition, diagnosing, 'awaiting_ci', 'job', { now }).run;

    expect(waiting.awaiting).toEqual({ kind: 'ci_result' });
    expect(waiting.deadlineAt?.toISOString()).toBe('2026-09-24T12:01:00.000Z');
    expect(isStuck(waiting)).toBe(false);
  });

  it('clears the deadline when the wait ends, by callback or by timeout', () => {
    const diagnosing = step(definition, begin(now).run, 'diagnosing', 'job', { now }).run;
    const waiting = step(definition, diagnosing, 'awaiting_ci', 'job', { now }).run;

    const byCallback = step(definition, waiting, 'done', 'callback', { now });
    expect(byCallback.run.deadlineAt).toBeUndefined();
    expect(byCallback.run.awaiting).toBeUndefined();
    expect(byCallback.transition.cause).toBe('callback');

    const byTimeout = step(definition, waiting, 'needs_human', 'timeout', { now });
    expect(byTimeout.transition.cause).toBe('timeout');
    expect(byTimeout.run.terminalState).toBe('needs_human');
  });

  it('gives a job-owned state a deadline too, from its declared wall-clock budget', () => {
    const { run } = begin(now);
    expect(run.awaiting).toBeUndefined();
    expect(run.deadlineAt?.toISOString()).toBe('2026-09-24T12:02:00.000Z');
    expect(isStuck(run)).toBe(false);
  });

  it('reports a run with no deadline as stuck — the residue no definition can produce', () => {
    const { run } = begin(now);
    const { deadlineAt: _d, ...noDeadline } = run;
    expect(isStuck(noDeadline)).toBe(true);
  });
});
