// @healer/domain-context — entry surface (003). Control-plane half of context resolution; the
// collector pool and the redactor live in `apps/runner/src/collection`.
export {
  COLLECTOR_REGISTRY,
  declaredCollectors,
  describeParameterSchema,
  type CollectorDeclaration,
} from './domain/collector-registry.js';
export { GAP_REASON_CODES, type GapReasonCode } from './domain/gap-reasons.js';
export { Untrusted } from './domain/untrusted.js';
export * from './domain/events.js';
export type { NewAuditEntry } from './domain/audit-entry.js';
export {
  buildCollectionPassAudit,
  COLLECT_PASS_AUDIT_ACTION,
  type CollectionPassAuditInput,
} from './domain/collection-audit.js';
export {
  BoundarySchemaRejectedError,
  type BoundaryRejection,
  type BoundaryRejectionRepository,
  type BoundaryRejectionSummary,
  type NewBoundaryRejection,
} from './domain/boundary-rejection-repository.js';
export type { CollectorRegistrationRepository } from './domain/collector-registration-repository.js';
export {
  acceptResultBatch,
  type AcceptResultBatchDeps,
} from './application/commands/accept-result-batch.js';
export { PrismaBoundaryRejectionRepository } from './infrastructure/prisma-boundary-rejection-repository.js';
export { PrismaCollectorRegistrationRepository } from './infrastructure/prisma-collector-registration-repository.js';
