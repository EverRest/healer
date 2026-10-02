import type { TenantScoped } from '@healer/shared';
import type { NewGraphAuditEntry } from './graph-audit-entry.js';

export interface ConfirmDraftItemsInput {
  readonly draftId: string;
  readonly itemIds: readonly string[];
  readonly actorRef: string;
  readonly reason: string;
  readonly now?: Date;
}

export interface ConfirmedItemResult {
  readonly itemId: string;
  readonly nodeId?: string;
  readonly edgeId?: string;
}

export interface ConfirmDraftItemsResult {
  readonly version: number;
  readonly confirmedItems: readonly ConfirmedItemResult[];
}

export interface RejectDraftItemsInput {
  readonly draftId: string;
  readonly itemIds: readonly string[];
  readonly actorRef: string;
  readonly reason: string;
  readonly now?: Date;
}

export interface RejectDraftItemsResult {
  readonly rejectedItemIds: readonly string[];
}

/**
 * T026's write surface. Both methods assume the caller (`confirmDraftItems`/`rejectDraftItems` in
 * `application/`) has already enforced FR-010's human-actor gate — this interface only ever
 * receives a human `actorRef`. `recordAuditEntry` is the one write a *refused* attempt needs
 * (T025): it has no larger mutation to join, so it is exposed directly rather than folded into
 * either decision method.
 *
 * `confirmDraftItems` throws `HealerError('DRAFT_ITEM_SUPERSEDED', …)` when any requested item's
 * live target no longer matches what the draft recorded (T027/T028, R-07) — the whole call applies
 * nothing in that case, never a partial batch. `rejectDraftItems` mints no `graph_version`:
 * `GraphVersion.mintedBy`'s closed set has no `rejection` member — rejecting changes nothing in the
 * graph, only `draft_item.state` and `proposal_rejection` (FR-011).
 */
export interface DraftReviewRepository {
  confirmDraftItems(where: TenantScoped<ConfirmDraftItemsInput>): Promise<ConfirmDraftItemsResult>;
  rejectDraftItems(where: TenantScoped<RejectDraftItemsInput>): Promise<RejectDraftItemsResult>;
  recordAuditEntry(where: TenantScoped<NewGraphAuditEntry>): Promise<void>;
}
