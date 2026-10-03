import { scope, type TenantContext, type TenantScoped } from '@healer/shared';
import type { CollectorKey, GapReasonCode, SourceStatus } from '@healer/boundary-contract';
import type { NewAuditEntry } from './audit-entry.js';

/**
 * One audit entry per collection pass (003 T015, FR-027, quickstart 47). A *registered*,
 * non-mutating `policy_action` key (seeded by `db-seed`, owningSpec 003): `check:policy-coverage`
 * reports an unregistered action as its own violation, and collection reads — it changes nothing a
 * decision would gate.
 */
export const COLLECT_PASS_AUDIT_ACTION = 'context.collect_pass';

export interface CollectionPassAuditInput {
  readonly auditId: string;
  readonly runnerId: string;
  readonly passId: string;
  readonly planDigest: string;
  readonly contractVersion: number;
  readonly rulesetVersions: {
    readonly collection: number;
    readonly redaction: number;
    readonly normalisation: number;
    readonly ranking: number;
  };
  readonly sourceOutcomes: readonly {
    readonly collectorKey: CollectorKey;
    readonly status: SourceStatus;
    readonly reasonCode?: GapReasonCode;
  }[];
  readonly itemsTransmitted: number;
  readonly itemsWithheld: number;
  readonly evidenceIds: readonly string[];
}

/**
 * `audit_entry` has no structured column, so `reason` carries the pass's facts as a canonical JSON
 * summary: plan digest (the plan itself is the `collection_pass` row it names), ruleset versions,
 * per-source outcomes, transmitted and withheld counts and the contract version. Only ids, enums
 * and integers go in — never an item, so the audit trail cannot become a second copy of the data.
 */
export function buildCollectionPassAudit(
  context: TenantContext,
  input: CollectionPassAuditInput,
): TenantScoped<NewAuditEntry> {
  const summary = {
    planDigest: input.planDigest,
    contractVersion: input.contractVersion,
    rulesetVersions: input.rulesetVersions,
    sourceOutcomes: input.sourceOutcomes.map((o) => ({
      collectorKey: o.collectorKey,
      status: o.status,
      ...(o.reasonCode !== undefined ? { reasonCode: o.reasonCode } : {}),
    })),
    itemsTransmitted: input.itemsTransmitted,
    itemsWithheld: input.itemsWithheld,
  };
  return scope(context, {
    id: input.auditId,
    actorType: 'runner' as const,
    actorRef: input.runnerId,
    action: COLLECT_PASS_AUDIT_ACTION,
    targetType: 'collection_pass',
    targetId: input.passId,
    reason: JSON.stringify(summary),
    evidenceIds: input.evidenceIds,
    outcome: input.sourceOutcomes.every((o) => o.status === 'collected') ? 'collected' : 'degraded',
  });
}
