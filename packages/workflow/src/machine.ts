import { randomUUID } from 'node:crypto';

/**
 * The persisted state machine (012 FR-029, 001 FR-013).
 *
 * Two properties this file exists to hold:
 *
 *  1. **The persisted transitions are the audit trail.** There is no second store of
 *     machine steps, and none of them is copied into 001's `issue_event`, which holds
 *     domain facts (C-14). A transition here is a machine step; a signal arriving is not.
 *  2. **Never wait inside a job** (ADR 0003). A state that waits declares what it waits
 *     for and a deadline. The run is then *persisted state*, and progress arrives as an
 *     inbound callback or as a deadline tick — never as a worker holding a promise.
 */
export type TransitionCause = 'job' | 'callback' | 'timeout' | 'human' | 'policy';

/**
 * A state is one of exactly three things, and the union is what makes the data-model
 * invariant — *a non-terminal run has a pending callback or a deadline* — true by
 * construction rather than reported by a nightly check:
 *
 *  - `terminal`: never left, no deadline needed;
 *  - `awaits`: waiting for an inbound callback, with the timeout that wakes it;
 *  - `jobBudgetMs`: owned by a job, with the declared wall-clock budget that bounds it
 *    (FR-027, R-02) — a breach is a transition with cause `timeout`, not a job that
 *    silently succeeds late.
 *
 * There is no fourth shape, so a state with nothing to wake it cannot be declared.
 */
export type WorkflowState = { readonly name: string } & (
  | {
      readonly terminal: true;
      /** Empty; enforced by `compile`, because an empty-tuple type poisons every read of `to`. */
      readonly to: readonly string[];
      readonly awaits?: never;
      readonly jobBudgetMs?: never;
    }
  | {
      readonly terminal?: false;
      readonly to: readonly string[];
      readonly awaits: { readonly kind: string; readonly timeoutMs: number };
      readonly jobBudgetMs?: never;
    }
  | {
      readonly terminal?: false;
      readonly to: readonly string[];
      readonly awaits?: never;
      readonly jobBudgetMs: number;
    }
);

export interface WorkflowDefinition {
  readonly key: string;
  readonly version: number;
  readonly initial: string;
  readonly states: readonly WorkflowState[];
}

export class WorkflowDefinitionError extends Error {}
export class InvalidTransitionError extends Error {}

export interface CompiledDefinition extends WorkflowDefinition {
  state(name: string): WorkflowState;
}

/**
 * Validates a definition once, at load. Three shapes are rejected here rather than
 * discovered in production: a transition to a state that does not exist, a terminal state
 * with outgoing edges, and a waiting state with no timeout — the last being precisely the
 * run that hangs forever with nothing to wake it.
 */
export function compile(definition: WorkflowDefinition): CompiledDefinition {
  const byName = new Map(definition.states.map((s) => [s.name, s]));
  if (byName.size !== definition.states.length) {
    throw new WorkflowDefinitionError('duplicate state name');
  }
  if (!byName.has(definition.initial)) {
    throw new WorkflowDefinitionError(`initial state ${definition.initial} is not declared`);
  }
  for (const state of definition.states) {
    // Read once, before any narrowing. The last check below narrows `state` to `never` —
    // which is the compiler proving the shape is undeclarable — and a `never` has no `name`.
    const name = state.name;
    for (const target of state.to) {
      if (!byName.has(target)) {
        throw new WorkflowDefinitionError(`${name} → ${target}: no such state`);
      }
    }
    if (state.terminal && state.to.length > 0) {
      throw new WorkflowDefinitionError(`terminal state ${name} declares transitions`);
    }
    if (state.awaits && !(state.awaits.timeoutMs > 0)) {
      throw new WorkflowDefinitionError(`${name} waits with no timeout — nothing would wake it`);
    }
    if (state.jobBudgetMs !== undefined && !(state.jobBudgetMs > 0)) {
      throw new WorkflowDefinitionError(`${name} declares a non-positive job budget`);
    }
    // The type union already forbids this; the runtime check exists because definitions
    // also arrive from JSON, where the compiler was never involved.
    if (!state.terminal && !state.awaits && state.jobBudgetMs === undefined) {
      throw new WorkflowDefinitionError(
        `${name} is non-terminal with neither a callback to wake it nor a job budget to bound it`,
      );
    }
  }
  return {
    ...definition,
    state(name: string): WorkflowState {
      const found = byName.get(name);
      if (!found) throw new InvalidTransitionError(`no such state: ${name}`);
      return found;
    },
  };
}

export interface WorkflowRun {
  readonly id: string;
  readonly tenantId: string;
  readonly issueId: string;
  readonly definitionKey: string;
  /** Pinned at start: a redeploy does not migrate a running instance. */
  readonly definitionVersion: number;
  readonly state: string;
  readonly awaiting?: { readonly kind: string; readonly token?: string };
  readonly correlationId: string;
  readonly startedAt: Date;
  readonly updatedAt: Date;
  readonly deadlineAt?: Date;
  readonly terminalState?: string;
}

export interface Transition {
  readonly id: string;
  readonly runId: string;
  readonly fromState: string;
  readonly toState: string;
  readonly cause: TransitionCause;
  readonly actorRef?: string;
  readonly payloadDigest?: string;
  readonly occurredAt: Date;
}

export interface StepResult {
  readonly run: WorkflowRun;
  readonly transition: Transition;
}

export function start(
  definition: CompiledDefinition,
  input: {
    tenantId: string;
    issueId: string;
    correlationId: string;
    id?: string;
    now?: Date;
  },
): StepResult {
  const now = input.now ?? new Date();
  const state = definition.state(definition.initial);
  const id = input.id ?? randomUUID();
  return {
    run: withAwaiting(
      {
        id,
        tenantId: input.tenantId,
        issueId: input.issueId,
        definitionKey: definition.key,
        definitionVersion: definition.version,
        state: state.name,
        correlationId: input.correlationId,
        startedAt: now,
        updatedAt: now,
      },
      state,
      now,
    ),
    transition: {
      id: randomUUID(),
      runId: id,
      fromState: '(none)',
      toState: state.name,
      cause: 'job',
      occurredAt: now,
    },
  };
}

/**
 * Moves a run. Refuses a transition a terminal run cannot make and one the definition
 * does not declare — the machine is the authority on what may happen next, not the caller.
 */
export function step(
  definition: CompiledDefinition,
  run: WorkflowRun,
  to: string,
  cause: TransitionCause,
  options: { actorRef?: string; payloadDigest?: string; now?: Date } = {},
): StepResult {
  const now = options.now ?? new Date();
  if (run.terminalState) {
    throw new InvalidTransitionError(
      `run ${run.id} is terminal in ${run.terminalState} and never transitions again`,
    );
  }
  const from = definition.state(run.state);
  if (!from.to.includes(to)) {
    throw new InvalidTransitionError(`${run.state} → ${to} is not declared by ${definition.key}`);
  }
  const target = definition.state(to);

  const moved = withAwaiting(
    {
      ...run,
      state: target.name,
      updatedAt: now,
      ...(target.terminal ? { terminalState: target.name } : {}),
    },
    target,
    now,
  );

  return {
    run: moved,
    transition: {
      id: randomUUID(),
      runId: run.id,
      fromState: run.state,
      toState: target.name,
      cause,
      ...(options.actorRef ? { actorRef: options.actorRef } : {}),
      ...(options.payloadDigest ? { payloadDigest: options.payloadDigest } : {}),
      occurredAt: now,
    },
  };
}

/**
 * Attaches (or clears) what the run is waiting for and its deadline. This is the single
 * place either is set, which is what keeps the invariant "a non-terminal run has a pending
 * callback or a deadline" true by construction rather than by a nightly check.
 */
function withAwaiting(run: WorkflowRun, state: WorkflowState, now: Date): WorkflowRun {
  if (state.terminal) {
    const { awaiting: _a, deadlineAt: _d, ...rest } = run;
    return { ...rest, terminalState: state.name };
  }
  if (state.awaits) {
    return {
      ...run,
      awaiting: { kind: state.awaits.kind },
      deadlineAt: new Date(now.getTime() + state.awaits.timeoutMs),
    };
  }
  // A job-owned state: no callback to wait for, but still a deadline — the job's declared
  // wall-clock budget. A breach is recorded as a `timeout` transition (FR-027).
  const { awaiting: _a, ...rest } = run;
  return { ...rest, deadlineAt: new Date(now.getTime() + state.jobBudgetMs) };
}

/**
 * A run that can neither be woken nor progressed. `compile` makes this undeclarable, so a
 * true here means a row predating a definition change or written outside the machine — the
 * periodic check of the data-model invariant exists for exactly that residue.
 */
export function isStuck(run: WorkflowRun): boolean {
  return !run.terminalState && !run.deadlineAt;
}
