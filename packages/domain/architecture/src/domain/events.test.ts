import { withCorrelation } from '@healer/shared';
import { describe, expect, it } from 'vitest';
import {
  discoveryDraftProposedEvent,
  graphDriftDetectedEvent,
  graphElementStaleEvent,
  graphVersionPublishedEvent,
} from './events.js';

/** Type-checked by `tsc --build`, never invoked — calling it would need a correlated scope for no reason. */
function typeProofNeverCalled(): void {
  // @ts-expect-error 'confirmation' requires actorRef (FR-010) — mintedBy alone is not enough
  graphVersionPublishedEvent('tenant-1', {
    versionId: 'v1',
    version: 1,
    mintedBy: 'confirmation',
    changedElementCounts: {},
  });
  // @ts-expect-error 'drift_resolution' requires actorRef too — a human adjudication always has one
  graphVersionPublishedEvent('tenant-1', {
    versionId: 'v1',
    version: 1,
    mintedBy: 'drift_resolution',
    changedElementCounts: {},
  });
}
void typeProofNeverCalled;

describe('discoveryDraftProposedEvent (004 T014, graph-contract.md §4)', () => {
  it('carries draftId, runId, baseVersion and counts by op', () => {
    const event = withCorrelation('corr-1', () =>
      discoveryDraftProposedEvent('tenant-1', {
        draftId: 'draft-1',
        runId: 'run-1',
        baseVersion: 3,
        countsByOp: { add_node: 2, add_edge: 1, modify_attributes: 0, mark_removed: 0 },
      }),
    );
    expect(event).toEqual({
      name: 'DiscoveryDraftProposed',
      tenantId: 'tenant-1',
      subjectId: 'draft-1',
      correlationId: 'corr-1',
      payload: {
        draftId: 'draft-1',
        runId: 'run-1',
        baseVersion: 3,
        countsByOp: { add_node: 2, add_edge: 1, modify_attributes: 0, mark_removed: 0 },
      },
    });
  });

  it('refuses to build outside a correlated scope', () => {
    expect(() =>
      discoveryDraftProposedEvent('tenant-1', {
        draftId: 'draft-1',
        runId: 'run-1',
        baseVersion: 0,
        countsByOp: { add_node: 0, add_edge: 0, modify_attributes: 0, mark_removed: 0 },
      }),
    ).toThrow(/correlated scope/);
  });
});

describe('graphVersionPublishedEvent (004 T014, FR-014, SC-005)', () => {
  it('carries version, mintedBy, actorRef and changed element counts, subject is the version row', () => {
    const event = withCorrelation('corr-2', () =>
      graphVersionPublishedEvent('tenant-1', {
        versionId: 'version-row-1',
        version: 8,
        mintedBy: 'confirmation',
        actorRef: 'alice',
        changedElementCounts: { nodes: 3, edges: 5 },
      }),
    );
    expect(event).toEqual({
      name: 'GraphVersionPublished',
      tenantId: 'tenant-1',
      subjectId: 'version-row-1',
      correlationId: 'corr-2',
      payload: {
        version: 8,
        mintedBy: 'confirmation',
        actorRef: 'alice',
        changedElementCounts: { nodes: 3, edges: 5 },
      },
    });
  });

  it('omits actorRef when absent for a mintedBy that does not require one (manual_edit)', () => {
    const event = withCorrelation('corr-3', () =>
      graphVersionPublishedEvent('tenant-1', {
        versionId: 'version-row-2',
        version: 9,
        mintedBy: 'manual_edit',
        changedElementCounts: { nodes: 1, edges: 0 },
      }),
    );
    expect('actorRef' in event.payload).toBe(false);
  });

  it('carries actorRef for a drift_resolution, which always names a human adjudication', () => {
    const event = withCorrelation('corr-3b', () =>
      graphVersionPublishedEvent('tenant-1', {
        versionId: 'version-row-3',
        version: 10,
        mintedBy: 'drift_resolution',
        actorRef: 'bob',
        changedElementCounts: { nodes: 0, edges: 1 },
      }),
    );
    expect(event.payload).toMatchObject({ mintedBy: 'drift_resolution', actorRef: 'bob' });
  });
});

describe('graphDriftDetectedEvent (004 T014, FR-017, FR-018)', () => {
  it('carries findingId, kind, issueId and the graph version the disagreement was found against', () => {
    const event = withCorrelation('corr-4', () =>
      graphDriftDetectedEvent('tenant-1', {
        findingId: 'finding-1',
        kind: 'observed_edge_absent',
        issueId: 'issue-1',
        graphVersion: 12,
      }),
    );
    expect(event).toEqual({
      name: 'GraphDriftDetected',
      tenantId: 'tenant-1',
      subjectId: 'finding-1',
      correlationId: 'corr-4',
      payload: {
        findingId: 'finding-1',
        kind: 'observed_edge_absent',
        issueId: 'issue-1',
        graphVersion: 12,
      },
    });
  });
});

describe('graphElementStaleEvent (004 T014, FR-019)', () => {
  it('carries nodeId and lastObservedAt as an ISO string, in the payload itself (review fix — not only subjectId)', () => {
    const event = withCorrelation('corr-5', () =>
      graphElementStaleEvent('tenant-1', {
        nodeId: 'node-1',
        lastObservedAt: new Date('2026-01-01T00:00:00Z'),
      }),
    );
    expect(event).toEqual({
      name: 'GraphElementStale',
      tenantId: 'tenant-1',
      subjectId: 'node-1',
      correlationId: 'corr-5',
      payload: { nodeId: 'node-1', lastObservedAt: '2026-01-01T00:00:00.000Z' },
    });
  });

  it('refuses to build outside a correlated scope', () => {
    expect(() =>
      graphElementStaleEvent('tenant-1', { nodeId: 'node-1', lastObservedAt: new Date() }),
    ).toThrow(/correlated scope/);
  });
});
