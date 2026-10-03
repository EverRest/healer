import { currentCorrelationId } from '@healer/shared';
import type { DomainEvent } from '@healer/events';
import type {
  CollectorKey,
  GapReasonCode,
  ItemClass,
  SourceStatus,
} from '@healer/boundary-contract';

/**
 * Outbox publishers for `contracts/collection-plan.md`'s "Events published through the outbox"
 * (003 T014, 012 FR-031). A command writes its state change and one of these inside the *same*
 * transaction (`enqueue(new PrismaOutboxTransaction(tx), …)`), the way 002's `events.ts` does.
 * `subjectId` is the aggregate the event is about and is not repeated inside `payload`.
 *
 * Payloads are structural by construction — ids, enums, counts — so an event cannot carry what the
 * boundary kept out: there is no field a collected excerpt could be put in.
 */
function requireCorrelationId(): string {
  const id = currentCorrelationId();
  if (id === undefined) {
    throw new Error('cannot publish a domain event outside a correlated scope (withCorrelation)');
  }
  return id;
}

export type BudgetState = 'within' | 'degraded' | 'budget_limited';

export function contextCollectedEvent(
  tenantId: string,
  snapshot: {
    readonly snapshotId: string;
    readonly issueId: string;
    readonly version: number;
    readonly completeness: Readonly<Record<string, unknown>>;
    readonly budgetState: BudgetState;
  },
): DomainEvent {
  return {
    name: 'ContextCollected',
    tenantId,
    subjectId: snapshot.snapshotId,
    correlationId: requireCorrelationId(),
    payload: {
      issueId: snapshot.issueId,
      version: snapshot.version,
      completeness: snapshot.completeness,
      budgetState: snapshot.budgetState,
    },
  };
}

export function contextPassDispatchedEvent(
  tenantId: string,
  pass: {
    readonly passId: string;
    readonly planDigest: string;
    readonly collectorKeys: readonly CollectorKey[];
  },
): DomainEvent {
  return {
    name: 'ContextPassDispatched',
    tenantId,
    subjectId: pass.passId,
    correlationId: requireCorrelationId(),
    payload: { planDigest: pass.planDigest, collectorKeys: [...pass.collectorKeys] },
  };
}

export function contextDegradedEvent(
  tenantId: string,
  degradation: {
    readonly passId: string;
    readonly collectorKey: CollectorKey;
    readonly status: Exclude<SourceStatus, 'collected'>;
    readonly reasonCode: GapReasonCode;
    /** The `collection_gap` evidence record that makes this absence citable (R-07). */
    readonly gapEvidenceId: string;
  },
): DomainEvent {
  return {
    name: 'ContextDegraded',
    tenantId,
    subjectId: degradation.passId,
    correlationId: requireCorrelationId(),
    payload: {
      collectorKey: degradation.collectorKey,
      status: degradation.status,
      reasonCode: degradation.reasonCode,
      gapEvidenceId: degradation.gapEvidenceId,
    },
  };
}

export function contextItemWithheldEvent(
  tenantId: string,
  withheld: {
    readonly passId: string;
    /** Resolves only inside the customer's plane — the control plane cannot dereference it (R-08). */
    readonly localRef: string;
    readonly itemClass: ItemClass;
    readonly reasonCode: GapReasonCode;
  },
): DomainEvent {
  return {
    name: 'ContextItemWithheld',
    tenantId,
    subjectId: withheld.passId,
    correlationId: requireCorrelationId(),
    payload: {
      localRef: withheld.localRef,
      itemClass: withheld.itemClass,
      reasonCode: withheld.reasonCode,
    },
  };
}

export function boundaryPayloadRejectedEvent(
  tenantId: string,
  rejection: {
    readonly rejectionId: string;
    readonly runnerId: string;
    readonly contractVersion: number;
    readonly schemaErrorPaths: readonly string[];
  },
): DomainEvent {
  return {
    name: 'BoundaryPayloadRejected',
    tenantId,
    subjectId: rejection.rejectionId,
    correlationId: requireCorrelationId(),
    payload: {
      runnerId: rejection.runnerId,
      contractVersion: rejection.contractVersion,
      schemaErrorPaths: [...rejection.schemaErrorPaths],
    },
  };
}
