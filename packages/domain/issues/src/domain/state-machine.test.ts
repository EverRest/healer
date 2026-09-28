import { describe, expect, it } from 'vitest';
import { InvalidIssueTransitionError, transitionIssue } from './state-machine.js';
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

  it('investigating -> diagnosed -> acting -> resolved, the happy path (closed by a person in v1)', () => {
    let current = issue('investigating');
    current = transitionIssue(current, 'diagnosed', 'agent', 'diagnosis-engine').issue;
    current = transitionIssue(current, 'acting', 'agent', 'change-agent').issue;
    current = transitionIssue(current, 'resolved', 'human', 'pavlo').issue;
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

  it('every non-removed state can be merged, and merged can only be removed', () => {
    for (const state of [
      'detected',
      'investigating',
      'diagnosed',
      'acting',
      'needs_human',
      'stale',
      'resolved',
    ] as const) {
      expect(transitionIssue(issue(state), 'merged', 'human', 'pavlo').issue.state).toBe('merged');
    }
    expect(transitionIssue(issue('merged'), 'removed', 'policy', 'retention').issue.state).toBe(
      'removed',
    );
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
      ).toThrow(/only a human can resolve/);
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

  it('every other kind is unaffected — acting stays open to them, and a human can resolve them', () => {
    expect(
      transitionIssue(issue('diagnosed', 'production_incident'), 'acting', 'agent', 'x').issue
        .state,
    ).toBe('acting');
    expect(
      transitionIssue(issue('needs_human', 'production_incident'), 'resolved', 'human', 'x').issue
        .state,
    ).toBe('resolved');
  });
});

describe('only a human reaches resolved in v1 (001 T057, C-09, contracts/events.md)', () => {
  // `IssueResolved` has no verified emitter yet: `fixed` is reserved (C-09, 008 R-25) and
  // `remediated` needs 010. Until one exists, an automated cause reaching `resolved` would be a
  // resolution nobody verified and nothing could honestly label — so it is refused, not labelled.
  it.each(['ingestion', 'agent', 'policy', 'system'] as const)(
    'refuses %s -> resolved from every state that has the edge',
    (cause) => {
      for (const state of [
        'detected',
        'investigating',
        'diagnosed',
        'acting',
        'needs_human',
        'stale',
      ] as const) {
        expect(() => transitionIssue(issue(state), 'resolved', cause, 'x')).toThrow(
          InvalidIssueTransitionError,
        );
        expect(() => transitionIssue(issue(state), 'resolved', cause, 'x')).toThrow(/only a human/);
      }
    },
  );

  it('does not restrict the other targets — an automated cause can still investigate, go stale or merge', () => {
    expect(
      transitionIssue(issue('resolved'), 'investigating', 'ingestion', 'signal').issue.state,
    ).toBe('investigating');
    expect(transitionIssue(issue('detected'), 'stale', 'system', 'sweep').issue.state).toBe(
      'stale',
    );
    expect(transitionIssue(issue('resolved'), 'merged', 'agent', 'x').issue.state).toBe('merged');
  });
});
