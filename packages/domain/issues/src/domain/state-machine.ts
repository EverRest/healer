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

/**
 * Two callers validated a transition against the same read of `issue.state` and only one of
 * them can legitimately win the write — the repository's guarded update (`WHERE state = <the
 * state this transition was validated against>`) detects the other one losing the race and
 * throws this instead of silently overwriting a state a concurrent actor already moved past.
 * The caller's own retry (re-read, re-validate, re-attempt) is the correct response, not
 * something this error tries to do on the transition's behalf.
 */
export class ConcurrentModificationError extends Error {
  constructor(readonly resource: string) {
    super(`${resource} was modified concurrently — reread and retry`);
    this.name = 'ConcurrentModificationError';
  }
}

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

/**
 * `knowledge_drift` MUST terminate at human adjudication and MUST NOT be reproduced, patched or
 * auto-resolved in either direction (FR-001a, 001 T038) — only a person knows whether the
 * disagreeing document is stale or the code is wrong. The graph itself carries no `kind`, so this
 * is the one place that narrows it: `acting` (data-model.md: "action taken", the only state
 * representing an executed change) is refused unconditionally. "Auto-resolve in either direction"
 * is an automated cause reaching `resolved`; that is refused for *every* kind by
 * `checkResolutionCause` below, the one authority for it (C-59's clause, generalised by 001 T057) —
 * a person choosing to close a drift issue stays allowed (FR-021).
 */
function checkKnowledgeDriftGuard(issue: Issue, to: IssueState): void {
  if (issue.kind !== 'knowledge_drift') return;
  if (to === 'acting') {
    throw new InvalidIssueTransitionError(
      `knowledge_drift issues cannot enter acting — they terminate at human adjudication (FR-001a)`,
    );
  }
}

/**
 * `resolved` is reachable only by a human close in v1 (001 T057, FR-021, C-09): the other two
 * resolution kinds need a verified emitter — `fixed` is reserved with no emitter (008 R-25) and
 * `remediated` waits on 010's `RemediationVerified` — and neither exists. Refusing the edge for
 * every other cause, rather than labelling it, keeps "resolved" from ever meaning something
 * nobody verified; the day a verified emitter lands it gets its own entry point carrying the
 * evidence ids, not a widened cause list here.
 */
function checkResolutionCause(to: IssueState, cause: IssueEventCause): void {
  if (to === 'resolved' && cause !== 'human') {
    throw new InvalidIssueTransitionError(
      `only a human can resolve an issue in v1 (cause: ${cause}) — no verified-resolution emitter exists yet (C-09)`,
    );
  }
}

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
  checkKnowledgeDriftGuard(issue, to);
  checkResolutionCause(to, cause);
  return {
    issue: { ...issue, state: to },
    event: { issueId: issue.id, fromState: issue.state, toState: to, cause, actorRef },
  };
}
