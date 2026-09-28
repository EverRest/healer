import { withCorrelation } from '@healer/shared';
import { describe, expect, it } from 'vitest';
import {
  issueDetectedEvent,
  issueMergedEvent,
  issueRelatedEvent,
  issueStaleEvent,
  issueStateChangedEvent,
  issueUnmergedEvent,
} from './events.js';
import type { Issue, IssueRelationship } from './issue.js';

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

  it('issueRelatedEvent carries the key payload the contract names (001 T039, FR-020)', () => {
    const relationship: IssueRelationship = {
      id: 'rel-1',
      tenantId: 'tenant-1',
      issueId: 'issue-1',
      otherIssueId: 'issue-2',
      kind: 'related',
      rule: 'component_environment_window',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    };
    const event = withCorrelation('corr-3', () => issueRelatedEvent('tenant-1', relationship));
    expect(event).toMatchObject({
      name: 'IssueRelated',
      tenantId: 'tenant-1',
      subjectId: 'issue-1',
      correlationId: 'corr-3',
      payload: { otherIssueId: 'issue-2', rule: 'component_environment_window' },
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

describe('issueStaleEvent (001 T051, contracts/events.md)', () => {
  it('carries lastProgressAt as an ISO string — the one payload field the contract names', () => {
    const event = withCorrelation('corr-1', () =>
      issueStaleEvent('tenant-1', 'issue-1', new Date('2026-01-01T00:00:00Z')),
    );
    expect(event).toMatchObject({
      name: 'IssueStale',
      tenantId: 'tenant-1',
      subjectId: 'issue-1',
      correlationId: 'corr-1',
      payload: { lastProgressAt: '2026-01-01T00:00:00.000Z' },
    });
  });
});

describe('issueMergedEvent / issueUnmergedEvent (001 T049/T050, contracts/events.md)', () => {
  it('IssueMerged names the survivor and the reason, on the merged issue’s own stream', () => {
    const event = withCorrelation('corr-1', () =>
      issueMergedEvent('tenant-1', 'issue-1', 'issue-2', 'same NPE'),
    );
    expect(event).toMatchObject({
      name: 'IssueMerged',
      tenantId: 'tenant-1',
      subjectId: 'issue-1',
      correlationId: 'corr-1',
      payload: { intoIssueId: 'issue-2', reason: 'same NPE' },
    });
  });

  it('IssueUnmerged names the issue it was merged into', () => {
    const event = withCorrelation('corr-1', () =>
      issueUnmergedEvent('tenant-1', 'issue-1', 'issue-2'),
    );
    expect(event).toMatchObject({
      name: 'IssueUnmerged',
      subjectId: 'issue-1',
      payload: { intoIssueId: 'issue-2' },
    });
  });

  it('both refuse to publish outside a correlated scope', () => {
    expect(() => issueMergedEvent('tenant-1', 'issue-1', 'issue-2', 'r')).toThrow(
      /correlated scope/,
    );
    expect(() => issueUnmergedEvent('tenant-1', 'issue-1', 'issue-2')).toThrow(/correlated scope/);
  });
});
