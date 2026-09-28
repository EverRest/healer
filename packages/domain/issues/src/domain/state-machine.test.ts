import { describe, expect, it } from 'vitest';
import {
  InvalidIssueTransitionError,
  mergeTransition,
  transitionIssue,
  unmergeTransition,
} from './state-machine.js';
import type { Issue } from './issue.js';

/**
 * Pure transition validation over the closed graph in data-model.md's "State transitions"
 * (001 T012, FR-006) — same technique as 012's `packages/workflow/src/machine.ts` `step()`: the
 * graph is the one authority on what may happen next, not the caller, and every transition
 * produces the event that records who or what caused it.
 */
function issue(state: Issue['state'], kind: Issue['kind'] = 'production_incident'): Issue {
  return {
    id: 'issue-1',
    tenantId: 'tenant-1',
    kind,
    componentId: null,
    environment: 'prod',
    severity: 'high',
    state,
    fingerprint: 'fp1',
    rulesetVersion: 1,
    occurrenceCount: 1n,
    firstSeenAt: new Date('2026-01-01T00:00:00Z'),
    lastSeenAt: new Date('2026-01-01T00:00:00Z'),
    staleAt: null,
    resolvedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };
}

describe('transitionIssue (001 T012, FR-006)', () => {
  it('detected -> investigating is declared', () => {
    const result = transitionIssue(issue('detected'), 'investigating', 'agent', 'context-resolver');
    expect(result.issue.state).toBe('investigating');
    expect(result.event).toMatchObject({
      issueId: 'issue-1',
      fromState: 'detected',
      toState: 'investigating',
      cause: 'agent',
      actorRef: 'context-resolver',
    });
  });

  it('investigating -> diagnosed -> acting -> resolved, the happy path', () => {
    let current = issue('investigating');
    current = transitionIssue(current, 'diagnosed', 'agent', 'diagnosis-engine').issue;
    current = transitionIssue(current, 'acting', 'agent', 'change-agent').issue;
    current = transitionIssue(current, 'resolved', 'agent', 'verifier').issue;
    expect(current.state).toBe('resolved');
  });

  it('diagnosed and acting can both reach needs_human — no path found', () => {
    expect(transitionIssue(issue('diagnosed'), 'needs_human', 'policy', 'gate').issue.state).toBe(
      'needs_human',
    );
    expect(transitionIssue(issue('acting'), 'needs_human', 'policy', 'gate').issue.state).toBe(
      'needs_human',
    );
  });

  it('any non-terminal state can be closed by a human directly to resolved', () => {
    for (const state of [
      'detected',
      'investigating',
      'diagnosed',
      'acting',
      'needs_human',
      'stale',
    ] as const) {
      expect(transitionIssue(issue(state), 'resolved', 'human', 'pavlo').issue.state).toBe(
        'resolved',
      );
    }
  });

  it('any non-terminal state can go stale — surfaced, not closed', () => {
    for (const state of [
      'detected',
      'investigating',
      'diagnosed',
      'acting',
      'needs_human',
    ] as const) {
      expect(transitionIssue(issue(state), 'stale', 'system', 'staleness-job').issue.state).toBe(
        'stale',
      );
    }
  });

  it('resolved reopens to investigating inside the reopen window', () => {
    expect(
      transitionIssue(issue('resolved'), 'investigating', 'ingestion', 'signal').issue.state,
    ).toBe('investigating');
  });

  const MERGEABLE = [
    'detected',
    'investigating',
    'diagnosed',
    'acting',
    'needs_human',
    'stale',
    'resolved',
  ] as const;

  it('merged can only be removed by a plain transition', () => {
    expect(transitionIssue(issue('merged'), 'removed', 'policy', 'retention').issue.state).toBe(
      'removed',
    );
    expect(() => transitionIssue(issue('merged'), 'investigating', 'human', 'pavlo')).toThrow(
      InvalidIssueTransitionError,
    );
  });

  it('a plain transition can never land on merged — state and merged_into row must not disagree (001 T049)', () => {
    for (const state of MERGEABLE) {
      expect(() => transitionIssue(issue(state), 'merged', 'human', 'pavlo')).toThrow(
        /merge is its own operation/,
      );
    }
  });

  it('mergeTransition: every state the graph lets reach merged does, and records who and from where', () => {
    for (const state of MERGEABLE) {
      const result = mergeTransition(issue(state), 'human', 'pavlo');
      expect(result.issue.state).toBe('merged');
      expect(result.event).toMatchObject({
        fromState: state,
        toState: 'merged',
        cause: 'human',
        actorRef: 'pavlo',
      });
    }
  });

  it('mergeTransition refuses an issue that is already merged or removed', () => {
    expect(() => mergeTransition(issue('merged'), 'human', 'pavlo')).toThrow(
      InvalidIssueTransitionError,
    );
    expect(() => mergeTransition(issue('removed'), 'human', 'pavlo')).toThrow(
      InvalidIssueTransitionError,
    );
  });

  it('unmergeTransition restores any state a merge could have started from', () => {
    for (const state of MERGEABLE) {
      const result = unmergeTransition(issue('merged'), state, 'human', 'pavlo');
      expect(result.issue.state).toBe(state);
      expect(result.event).toMatchObject({ fromState: 'merged', toState: state, cause: 'human' });
    }
  });

  it('unmergeTransition refuses an issue that is not merged, and a restore state a merge could not have left', () => {
    expect(() => unmergeTransition(issue('detected'), 'investigating', 'human', 'pavlo')).toThrow(
      InvalidIssueTransitionError,
    );
    expect(() => unmergeTransition(issue('removed'), 'detected', 'human', 'pavlo')).toThrow(
      InvalidIssueTransitionError,
    );
    for (const bad of ['merged', 'removed'] as const) {
      expect(() => unmergeTransition(issue('merged'), bad, 'human', 'pavlo')).toThrow(
        InvalidIssueTransitionError,
      );
    }
  });

  it('every state, including merged and resolved, can be removed — tenant deletion is unconditional', () => {
    for (const state of [
      'detected',
      'investigating',
      'diagnosed',
      'acting',
      'needs_human',
      'stale',
      'resolved',
      'merged',
    ] as const) {
      expect(transitionIssue(issue(state), 'removed', 'human', 'pavlo').issue.state).toBe(
        'removed',
      );
    }
  });

  it('removed is terminal — no transition out, not even to itself', () => {
    expect(() => transitionIssue(issue('removed'), 'resolved', 'human', 'pavlo')).toThrow(
      InvalidIssueTransitionError,
    );
    expect(() => transitionIssue(issue('removed'), 'removed', 'human', 'pavlo')).toThrow(
      InvalidIssueTransitionError,
    );
  });

  it('rejects an undeclared edge — diagnosed cannot jump straight back to detected', () => {
    expect(() => transitionIssue(issue('diagnosed'), 'detected', 'human', 'pavlo')).toThrow(
      /diagnosed -> detected is not a declared transition/,
    );
  });

  it('rejects stale reopening directly to investigating — only resolved has that edge today', () => {
    // Flagged in QUESTIONS.md rather than guessed: whether a new matching signal should also
    // revive a stale issue is T018's ingestion-attach decision, not this task's to invent ahead
    // of it. Today the diagram draws exactly one reopen edge, from resolved.
    expect(() => transitionIssue(issue('stale'), 'investigating', 'ingestion', 'signal')).toThrow(
      InvalidIssueTransitionError,
    );
  });
});

describe('knowledge_drift terminates at human adjudication (001 T038, FR-001a, quickstart 25)', () => {
  it('cannot enter acting — no kind of automated change is ever taken on it', () => {
    expect(() =>
      transitionIssue(issue('diagnosed', 'knowledge_drift'), 'acting', 'agent', 'change-agent'),
    ).toThrow(/knowledge_drift/);
  });

  it('cannot be auto-resolved in either direction — only a human resolution counts', () => {
    for (const cause of ['ingestion', 'agent', 'policy', 'system'] as const) {
      expect(() =>
        transitionIssue(issue('needs_human', 'knowledge_drift'), 'resolved', cause, 'x'),
      ).toThrow(/knowledge_drift/);
    }
  });

  it('a human can still resolve it — FR-001a blocks automated resolution, not a person closing it', () => {
    expect(
      transitionIssue(issue('needs_human', 'knowledge_drift'), 'resolved', 'human', 'pavlo').issue
        .state,
    ).toBe('resolved');
  });

  it('can still reach needs_human — the one path FR-001a requires it to terminate at', () => {
    expect(
      transitionIssue(issue('diagnosed', 'knowledge_drift'), 'needs_human', 'policy', 'gate').issue
        .state,
    ).toBe('needs_human');
  });

  it('every other kind is unaffected — acting and automated resolution stay open to them', () => {
    expect(
      transitionIssue(issue('diagnosed', 'production_incident'), 'acting', 'agent', 'x').issue
        .state,
    ).toBe('acting');
    expect(
      transitionIssue(issue('needs_human', 'production_incident'), 'resolved', 'agent', 'x').issue
        .state,
    ).toBe('resolved');
  });
});
