import type { Issue, IssueState } from './issue.js';

/**
 * The persisted issue state machine (001 T012, FR-006), built on the same technique as 012's
 * `packages/workflow/src/machine.ts` `step()`: a closed graph is the one authority on what may
 * happen next, not the caller, and every transition returns the event that records who or what
 * caused it — never a bare state write with no trail.
 *
 * Deliberately a simpler shape than 012's `WorkflowState`: that union's `awaits`/`jobBudgetMs`
 * exist to keep a *job* from hanging with nothing to wake it (ADR 0003) — a concern that belongs
 * to `workflow_run`, not to `issue.state`, which is a declarative status with no waiting
 * semantics of its own (C-14: this table holds domain facts, 012's `workflow_transition` holds
 * machine steps).
 */
export class InvalidIssueTransitionError extends Error {}

export type IssueEventCause = 'ingestion' | 'agent' | 'human' | 'policy' | 'system';

export interface NewIssueStateChangedEvent {
  readonly issueId: string;
  readonly fromState: IssueState;
  readonly toState: IssueState;
  readonly cause: IssueEventCause;
  readonly actorRef: string;
}

export interface IssueTransitionResult {
  readonly issue: Issue;
  readonly event: NewIssueStateChangedEvent;
}

/**
 * Exactly the edges data-model.md's "State transitions" diagram draws. `removed` has none — the
 * only truly terminal state. Every other state reaches `merged` and `removed` unconditionally,
 * matching the diagram's un-qualified "any --merge--> merged" / "any --tenant deletion-->
 * removed"; `merged` itself only reaches `removed` (unmerge is 001 T049's own mechanism, not a
 * state-graph edge this task invents ahead of it — flagged in QUESTIONS.md).
 */
const GRAPH: Readonly<Record<IssueState, readonly IssueState[]>> = {
  detected: ['investigating', 'resolved', 'stale', 'merged', 'removed'],
  investigating: ['diagnosed', 'resolved', 'stale', 'merged', 'removed'],
  diagnosed: ['acting', 'needs_human', 'resolved', 'stale', 'merged', 'removed'],
  acting: ['resolved', 'needs_human', 'stale', 'merged', 'removed'],
  needs_human: ['resolved', 'stale', 'merged', 'removed'],
  stale: ['resolved', 'merged', 'removed'],
  resolved: ['investigating', 'merged', 'removed'],
  merged: ['removed'],
  removed: [],
};

/** Refuses a transition the graph does not declare — see the module comment. */
export function transitionIssue(
  issue: Issue,
  to: IssueState,
  cause: IssueEventCause,
  actorRef: string,
): IssueTransitionResult {
  const allowed = GRAPH[issue.state];
  if (!allowed.includes(to)) {
    throw new InvalidIssueTransitionError(`${issue.state} -> ${to} is not a declared transition`);
  }
  return {
    issue: { ...issue, state: to },
    event: { issueId: issue.id, fromState: issue.state, toState: to, cause, actorRef },
  };
}
