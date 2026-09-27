import { describe, expect, it } from 'vitest';
import { projectIssueRelationships } from './issue.js';
import type { IssueRelationship, IssueRelationshipKind } from './issue.js';

function relationship(
  issueId: string,
  otherIssueId: string,
  kind: IssueRelationshipKind,
): IssueRelationship {
  return {
    id: `${issueId}-${otherIssueId}-${kind}`,
    tenantId: 'tenant-1',
    issueId,
    otherIssueId,
    kind,
    rule: 'component_environment_window',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };
}

describe('projectIssueRelationships (001 T040, FR-020)', () => {
  it('projects recurrenceOfId only when this issue is the subject', () => {
    const projection = projectIssueRelationships('a', [relationship('a', 'b', 'recurrence_of')]);
    expect(projection.recurrenceOfId).toBe('b');
    expect(projection.mergedIntoId).toBeNull();
    expect(projection.relatedIssueIds).toEqual([]);
  });

  it('does not project recurrenceOfId when this issue is the target, not the subject', () => {
    const projection = projectIssueRelationships('b', [relationship('a', 'b', 'recurrence_of')]);
    expect(projection.recurrenceOfId).toBeNull();
  });

  it('projects mergedIntoId the same way', () => {
    const projection = projectIssueRelationships('a', [relationship('a', 'b', 'merged_into')]);
    expect(projection.mergedIntoId).toBe('b');
  });

  it('collects relatedIssueIds from either direction', () => {
    const projection = projectIssueRelationships('a', [
      relationship('a', 'b', 'related'),
      relationship('c', 'a', 'related'),
    ]);
    expect([...projection.relatedIssueIds].sort()).toEqual(['b', 'c']);
  });

  it('returns an empty projection for an issue with no relationships at all', () => {
    expect(projectIssueRelationships('a', [])).toEqual({
      mergedIntoId: null,
      recurrenceOfId: null,
      relatedIssueIds: [],
    });
  });
});
