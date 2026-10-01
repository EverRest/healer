import type {
  DiscoveryItem,
  DiscoverySourceReasonCode,
  DiscoverySourceStatus,
} from './discovery-batch.js';
import type { CollectionGap } from './discovery-adapter.js';

/** What happened when `collectDiscovery` (T021) tried one source — the input to the status/reason
 *  mapping table below (plan "Source outcomes"). */
export type CollectionOutcome =
  | { readonly kind: 'not_requested' }
  | { readonly kind: 'threw' }
  | { readonly kind: 'timed_out' }
  | {
      readonly kind: 'completed';
      readonly items: readonly DiscoveryItem[];
      readonly gaps: readonly CollectionGap[];
      /** The item cap (T021 "bounded") truncated this source's results. */
      readonly truncated: boolean;
      /** T030: at least one item the adapter returned failed `validateEgress` and was dropped
       *  before transmission — plan "Ingestion rules": "a failing item is not sent (status
       *  `partial`, `schema_rejected`)" names this outcome for the egress side explicitly, not
       *  only for ingestion's independent re-check (`downgradeForRejectedItems` below). */
      readonly anyEgressRejected: boolean;
    };

export interface SourceOutcome {
  readonly status: DiscoverySourceStatus;
  readonly reasonCode: DiscoverySourceReasonCode | null;
}

/**
 * 003's six statuses, nine reason codes, no local set (plan "Source outcomes" table). Pure: given
 * what collection observed, this is the one place the mapping is written down — a unit test can
 * exercise every row without a database or a real adapter.
 */
export function deriveProvisionalSourceOutcome(outcome: CollectionOutcome): SourceOutcome {
  switch (outcome.kind) {
    case 'not_requested':
      return { status: 'not_attempted', reasonCode: null };
    case 'threw':
      return { status: 'unavailable', reasonCode: 'source_unreachable' };
    case 'timed_out':
      return { status: 'timed_out', reasonCode: 'timeout' };
    case 'completed':
      if (outcome.anyEgressRejected) return { status: 'partial', reasonCode: 'schema_rejected' };
      if (outcome.truncated) return { status: 'partial', reasonCode: null };
      if (outcome.gaps.length > 0) return { status: 'partial', reasonCode: null };
      if (outcome.items.length === 0) return { status: 'collected', reasonCode: 'empty_result' };
      return { status: 'collected', reasonCode: null };
  }
}

/**
 * Ingestion-side downgrade (plan "Ingestion rules"): a source that collection reported as
 * `collected` is downgraded to `partial`/`schema_rejected` the moment ingestion independently
 * rejects even one of its items — collection validating egress never excuses ingestion from
 * validating ingress (boundary-contract's `validation.ts` doc comment: "two distinct call sites
 * against the same closed schema, not one validation whose result both sides trust"). A source
 * already `partial` or worse for its own reason keeps that reason — ingestion only ever makes the
 * outcome worse, never better.
 */
export function downgradeForRejectedItems(
  outcome: SourceOutcome,
  hadRejectedItems: boolean,
): SourceOutcome {
  if (hadRejectedItems && outcome.status === 'collected') {
    return { status: 'partial', reasonCode: 'schema_rejected' };
  }
  return outcome;
}
