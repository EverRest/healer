import { withCorrelation } from '@healer/shared';
import { describe, expect, it } from 'vitest';
import { issueDetectedEvent, issueStateChangedEvent } from './events.js';
import type { Issue } from './issue.js';

const ISSUE: Issue = {
  id: 'issue-1',
  tenantId: 'tenant-1',
  kind: 'production_incident',
  componentId: 'component-1',
  environment: 'prod',
  severity: 'high',
  state: 'detected',
  fingerprint: 'fp1',
  rulesetVersion: 1,
  occurrenceCount: 1n,
  firstSeenAt: new Date('2026-01-01T00:00:00Z'),
  lastSeenAt: new Date('2026-01-01T00:00:00Z'),
  staleAt: null,
  resolvedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

describe('issueDetectedEvent / issueStateChangedEvent (001 T013, contracts/events.md)', () => {
  it('issueDetectedEvent carries the key payload the contract names', () => {
    const event = withCorrelation('corr-1', () => issueDetectedEvent(ISSUE));
    expect(event).toMatchObject({
      name: 'IssueDetected',
      tenantId: 'tenant-1',
      subjectId: 'issue-1',
      correlationId: 'corr-1',
      payload: {
        kind: 'production_incident',
        component: 'component-1',
        severity: 'high',
        fingerprint: 'fp1',
      },
    });
  });

  it('issueStateChangedEvent carries the key payload the contract names', () => {
    const event = withCorrelation('corr-2', () =>
      issueStateChangedEvent('tenant-1', {
        issueId: 'issue-1',
        fromState: 'detected',
        toState: 'investigating',
        cause: 'agent',
        actorRef: 'context-resolver',
      }),
    );
    expect(event).toMatchObject({
      name: 'IssueStateChanged',
      tenantId: 'tenant-1',
      subjectId: 'issue-1',
      correlationId: 'corr-2',
      payload: {
        fromState: 'detected',
        toState: 'investigating',
        cause: 'agent',
        actorRef: 'context-resolver',
      },
    });
  });

  it('refuses to build an event outside a correlated scope — inventing one would fake a trace', () => {
    expect(() => issueDetectedEvent(ISSUE)).toThrow(/correlated scope/);
    expect(() =>
      issueStateChangedEvent('tenant-1', {
        issueId: 'issue-1',
        fromState: 'detected',
        toState: 'investigating',
        cause: 'agent',
        actorRef: 'x',
      }),
    ).toThrow(/correlated scope/);
  });
});
