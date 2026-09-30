import { enqueue, type OutboxRecord, type OutboxTransaction } from '@healer/events';
import {
  discoveryDraftProposedEvent,
  graphDriftDetectedEvent,
  graphElementStaleEvent,
  graphVersionPublishedEvent,
  type DiscoveryDraftProposedPayload,
  type GraphDriftDetectedPayload,
  type GraphElementStalePayload,
  type GraphVersionPublishedPayload,
} from '../domain/events.js';

/**
 * Publishers for the four graph events (004 T014, 012 T012), each taking the caller's open
 * transaction rather than opening its own — the same shape as
 * `packages/domain/issues/src/infrastructure/prisma-issue-staleness.ts`'s
 * `enqueue(new PrismaOutboxTransaction(tx), issueStaleEvent(...))` call site. No command in this
 * feature's current scope opens that transaction yet (`ConfirmDraftItems`, version minting,
 * `RaiseDrift` and the staleness sweep are all Phase 3+ tasks), so these are called directly with
 * the transaction the future command already holds — never a fabricated one of their own.
 */

export function publishDiscoveryDraftProposed(
  tx: OutboxTransaction,
  tenantId: string,
  payload: DiscoveryDraftProposedPayload,
): Promise<OutboxRecord> {
  return enqueue(tx, discoveryDraftProposedEvent(tenantId, payload));
}

export function publishGraphVersionPublished(
  tx: OutboxTransaction,
  tenantId: string,
  payload: GraphVersionPublishedPayload,
): Promise<OutboxRecord> {
  return enqueue(tx, graphVersionPublishedEvent(tenantId, payload));
}

export function publishGraphDriftDetected(
  tx: OutboxTransaction,
  tenantId: string,
  payload: GraphDriftDetectedPayload,
): Promise<OutboxRecord> {
  return enqueue(tx, graphDriftDetectedEvent(tenantId, payload));
}

export function publishGraphElementStale(
  tx: OutboxTransaction,
  tenantId: string,
  payload: GraphElementStalePayload,
): Promise<OutboxRecord> {
  return enqueue(tx, graphElementStaleEvent(tenantId, payload));
}
