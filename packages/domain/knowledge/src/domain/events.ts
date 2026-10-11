import { currentCorrelationId, type TenantContext } from '@healer/shared';
import type { DomainEvent } from '@healer/events';
import type { HumanActorRef } from './human-actor-ref.js';

/**
 * Outbox events this package publishes (005 T014, retrieval-contract.md §5). Builders only: the
 * caller owns the transaction and passes the event to `enqueue(tx, event)` from `@healer/events`
 * (which takes an `OutboxTransaction`, so there is no way to publish outside one). Call sites are
 * Phase 3+ work.
 *
 * Tenant comes from a `TenantContext`, never a string. Payloads are closed shapes that carry ids
 * and facts only — never document text.
 */

/**
 * The one authority for this producer's event names. Drift is detected in three places with three
 * payloads (§5): 004 `GraphDriftDetected`, 006 `DiagnosisFoundKnowledgeDrift`, and this feature's
 * `KnowledgeDriftFindingRaised` — a shared name would have a consumer subscribe to a payload it
 * was not built for, so the test pins that none of the foreign names appears here.
 */
export const KNOWLEDGE_EVENT_NAMES = {
  draftProposed: 'ExpectationDraftProposed',
  adopted: 'ExpectationAdopted',
  adoptionRevoked: 'ExpectationAdoptionRevoked',
  driftFindingRaised: 'KnowledgeDriftFindingRaised',
  documentVersionIngested: 'DocumentVersionIngested',
} as const;

/** Same guard as the other event modules: no correlation scope, no second trace. */
function requireCorrelationId(): string {
  const id = currentCorrelationId();
  if (id === undefined) {
    throw new Error('cannot publish a domain event outside a correlated scope (withCorrelation)');
  }
  return id;
}

export interface ExpectationDraftProposedPayload {
  readonly expectedBehaviorId: string;
  readonly seedingSessionId: string;
  readonly extractionRule: string;
}

/** `ExpectationDraftProposed`: seeding produces a draft. */
export function expectationDraftProposedEvent(
  ctx: TenantContext,
  payload: ExpectationDraftProposedPayload,
): DomainEvent {
  return {
    name: KNOWLEDGE_EVENT_NAMES.draftProposed,
    tenantId: ctx.tenantId,
    subjectId: payload.expectedBehaviorId,
    correlationId: requireCorrelationId(),
    payload: {
      expectedBehaviorId: payload.expectedBehaviorId,
      seedingSessionId: payload.seedingSessionId,
      extractionRule: payload.extractionRule,
    },
  };
}

/**
 * Both fields are required: the grant is what makes an expectation an anchor, and `actorRef` names
 * the human — this is the one event that changes what a verification may do.
 */
export interface ExpectationAdoptedPayload {
  readonly anchorGrantId: string;
  readonly expectedBehaviorVersionId: string;
  readonly actorRef: HumanActorRef;
}

/** `ExpectationAdopted`: a human adoption wrote a grant. */
export function expectationAdoptedEvent(
  ctx: TenantContext,
  payload: ExpectationAdoptedPayload,
): DomainEvent {
  return {
    name: KNOWLEDGE_EVENT_NAMES.adopted,
    tenantId: ctx.tenantId,
    subjectId: payload.anchorGrantId,
    correlationId: requireCorrelationId(),
    payload: {
      anchorGrantId: payload.anchorGrantId,
      expectedBehaviorVersionId: payload.expectedBehaviorVersionId,
      actorRef: payload.actorRef,
    },
  };
}

export interface ExpectationAdoptionRevokedPayload {
  readonly anchorGrantId: string;
  readonly revokedBy: string;
  readonly reason: string;
}

/** `ExpectationAdoptionRevoked`: a human revoked. `anchor_grant.revoked_at` stays the record. */
export function expectationAdoptionRevokedEvent(
  ctx: TenantContext,
  payload: ExpectationAdoptionRevokedPayload,
): DomainEvent {
  return {
    name: KNOWLEDGE_EVENT_NAMES.adoptionRevoked,
    tenantId: ctx.tenantId,
    subjectId: payload.anchorGrantId,
    correlationId: requireCorrelationId(),
    payload: {
      anchorGrantId: payload.anchorGrantId,
      revokedBy: payload.revokedBy,
      reason: payload.reason,
    },
  };
}

/** data-model.md `knowledge_drift_finding.kind`. */
export type KnowledgeDriftKind =
  | 'document_contradicts_code'
  | 'document_contradicts_observation'
  | 'constraint_value_conflict'
  | 'expectation_references_missing_element';

/** A finding is about a document version, an expectation version, or both — never neither. */
export type KnowledgeDriftFindingRaisedPayload = {
  readonly findingId: string;
  readonly kind: KnowledgeDriftKind;
  readonly issueId: string;
} & (
  | { readonly documentVersionId: string; readonly expectedBehaviorVersionId?: string }
  | { readonly documentVersionId?: string; readonly expectedBehaviorVersionId: string }
);

/** `KnowledgeDriftFindingRaised`: a `knowledge_drift_finding` row of this feature exists. */
export function knowledgeDriftFindingRaisedEvent(
  ctx: TenantContext,
  payload: KnowledgeDriftFindingRaisedPayload,
): DomainEvent {
  // Runtime guard behind the type: null / '' from an untyped caller must not pass as "named".
  const present = (x: unknown): x is string => typeof x === 'string' && x !== '';
  const doc = payload.documentVersionId;
  const exp = payload.expectedBehaviorVersionId;
  if ((doc !== undefined && !present(doc)) || (exp !== undefined && !present(exp))) {
    throw new Error('documentVersionId / expectedBehaviorVersionId must be non-empty strings');
  }
  if (!present(doc) && !present(exp)) {
    throw new Error('a drift finding names documentVersionId or expectedBehaviorVersionId');
  }
  return {
    name: KNOWLEDGE_EVENT_NAMES.driftFindingRaised,
    tenantId: ctx.tenantId,
    subjectId: payload.findingId,
    correlationId: requireCorrelationId(),
    payload: {
      findingId: payload.findingId,
      kind: payload.kind,
      issueId: payload.issueId,
      ...(payload.documentVersionId !== undefined
        ? { documentVersionId: payload.documentVersionId }
        : {}),
      ...(payload.expectedBehaviorVersionId !== undefined
        ? { expectedBehaviorVersionId: payload.expectedBehaviorVersionId }
        : {}),
    },
  };
}

/**
 * `sourceModifiedAt` is optional: data-model.md has it nullable (a source may not report one).
 * retrieval-contract.md §5 lists it without `?`; the data model is followed.
 */
export interface DocumentVersionIngestedPayload {
  readonly documentId: string;
  readonly versionNo: number;
  readonly sourceModifiedAt?: string;
}

/** `DocumentVersionIngested`: a new version synced. */
export function documentVersionIngestedEvent(
  ctx: TenantContext,
  payload: DocumentVersionIngestedPayload,
): DomainEvent {
  return {
    name: KNOWLEDGE_EVENT_NAMES.documentVersionIngested,
    tenantId: ctx.tenantId,
    subjectId: payload.documentId,
    correlationId: requireCorrelationId(),
    payload: {
      documentId: payload.documentId,
      versionNo: payload.versionNo,
      ...(payload.sourceModifiedAt !== undefined
        ? { sourceModifiedAt: payload.sourceModifiedAt }
        : {}),
    },
  };
}
