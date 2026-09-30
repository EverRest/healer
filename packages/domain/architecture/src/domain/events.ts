import { currentCorrelationId } from '@healer/shared';
import type { DomainEvent } from '@healer/events';

/**
 * Outbox events this package publishes (004 T014, 012 T012, graph-contract.md §4). None has a real
 * caller yet — every command that would raise one (`ConfirmDraftItems`, minting a version,
 * `RaiseDrift`, the staleness sweep) is Phase 3+ work in this feature's own tasks.md. This is the
 * publishable contract those commands call into, the same precedent
 * `packages/domain/issues/src/domain/events.ts` set for `IssueReopened`/`IssueRecurred` before
 * either had an emitter (see 001's QUESTIONS.md "seven of the eleven contract events have no
 * publisher yet").
 */

/**
 * Requires an active correlation scope (`@healer/shared`'s tracing module), the same guard every
 * event builder in `packages/domain/issues/src/domain/events.ts` uses — inventing one here would
 * produce a second trace for the same work.
 */
function requireCorrelationId(): string {
  const id = currentCorrelationId();
  if (id === undefined) {
    throw new Error('cannot publish a domain event outside a correlated scope (withCorrelation)');
  }
  return id;
}

export interface DiscoveryDraftProposedPayload {
  readonly draftId: string;
  readonly runId: string;
  readonly baseVersion: number;
  readonly countsByOp: Readonly<
    Record<'add_node' | 'add_edge' | 'modify_attributes' | 'mark_removed', number>
  >;
}

/** `DiscoveryDraftProposed` (graph-contract.md §4): a run produces a draft. */
export function discoveryDraftProposedEvent(
  tenantId: string,
  payload: DiscoveryDraftProposedPayload,
): DomainEvent {
  return {
    name: 'DiscoveryDraftProposed',
    tenantId,
    subjectId: payload.draftId,
    correlationId: requireCorrelationId(),
    payload: {
      draftId: payload.draftId,
      runId: payload.runId,
      baseVersion: payload.baseVersion,
      countsByOp: payload.countsByOp,
    },
  };
}

/**
 * `actorRef` is required exactly when FR-010/FR-025 require one to have been recorded: a
 * confirmation is a human action by construction, and a drift resolution is always a human
 * adjudication (spec assumption — drift "terminates at human adjudication"). `manual_edit` and
 * `rename` do not carry that same guarantee yet in this batch's scope (no command mints either one
 * today), so their `actorRef` stays optional rather than falsely promising one. A discriminated
 * union on `mintedBy` makes "confirmed with no actor" unrepresentable instead of merely unchecked
 * (docs/patterns.md), which a single optional field could not do.
 */
export type GraphVersionPublishedPayload = {
  /** `graph_version.id` — the aggregate this event is about (outbox's `subjectId`). */
  readonly versionId: string;
  readonly version: number;
  readonly changedElementCounts: Readonly<Record<string, number>>;
} & (
  | { readonly mintedBy: 'confirmation' | 'drift_resolution'; readonly actorRef: string }
  | { readonly mintedBy: 'manual_edit' | 'rename'; readonly actorRef?: string }
);

/**
 * `GraphVersionPublished` (graph-contract.md §4): a confirmation, edit or drift resolution mints a
 * version. The signal a consumer holding a pinned version uses to decide whether to re-query —
 * nothing is invalidated automatically (FR-014, SC-005).
 */
export function graphVersionPublishedEvent(
  tenantId: string,
  payload: GraphVersionPublishedPayload,
): DomainEvent {
  return {
    name: 'GraphVersionPublished',
    tenantId,
    subjectId: payload.versionId,
    correlationId: requireCorrelationId(),
    payload: {
      version: payload.version,
      mintedBy: payload.mintedBy,
      ...(payload.actorRef !== undefined ? { actorRef: payload.actorRef } : {}),
      changedElementCounts: payload.changedElementCounts,
    },
  };
}

export interface GraphDriftDetectedPayload {
  readonly findingId: string;
  readonly kind:
    | 'observed_edge_absent'
    | 'recorded_edge_contradicted'
    | 'deployment_unit_missing'
    | 'product_link_dangling';
  readonly issueId: string;
  readonly graphVersion: number;
}

/** `GraphDriftDetected` (graph-contract.md §4): drift is raised, routed to a human (FR-017, FR-018). */
export function graphDriftDetectedEvent(
  tenantId: string,
  payload: GraphDriftDetectedPayload,
): DomainEvent {
  return {
    name: 'GraphDriftDetected',
    tenantId,
    subjectId: payload.findingId,
    correlationId: requireCorrelationId(),
    payload: {
      findingId: payload.findingId,
      kind: payload.kind,
      issueId: payload.issueId,
      graphVersion: payload.graphVersion,
    },
  };
}

export interface GraphElementStalePayload {
  readonly nodeId: string;
  readonly lastObservedAt: Date;
}

/**
 * `GraphElementStale` (graph-contract.md §4): an element passes its staleness window (FR-019).
 * Surfaced, never a deletion. The contract names `nodeId` as a payload field in its own right, not
 * only as the outbox envelope's `subjectId` — a consumer reading `payload.nodeId` (review finding)
 * must not get `undefined` because the id was only carried one level up.
 */
export function graphElementStaleEvent(
  tenantId: string,
  payload: GraphElementStalePayload,
): DomainEvent {
  return {
    name: 'GraphElementStale',
    tenantId,
    subjectId: payload.nodeId,
    correlationId: requireCorrelationId(),
    payload: { nodeId: payload.nodeId, lastObservedAt: payload.lastObservedAt.toISOString() },
  };
}
