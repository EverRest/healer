import { NotFoundError, scope, type TenantContext, type TenantScoped } from '@healer/shared';
import type { EvidenceRetentionRepository } from '../../domain/retention.js';

/**
 * What retention needs, as one type: `detach` is the existing mutation (any return value — only
 * that it happened matters here), `purge` the new destructive one. Nothing else on
 * `EvidenceRepository` (no `record`) is reachable from here.
 */
export type RetentionStore = EvidenceRetentionRepository & {
  detach(where: TenantScoped<{ readonly id: string }>): Promise<unknown>;
};

export interface RetentionResult {
  readonly purged: number;
  readonly detached: number;
  /** Gone, or cited between the read and the write — nothing left for retention to do. */
  readonly skipped: number;
}

/**
 * The retention sweep (001 T052, R-04, FR-009, FR-018): expired evidence nothing cites is purged;
 * expired evidence a conclusion cites is **detached, never deleted** — the row, its excerpt and its
 * `source_label` stay ("from logs, March"), because deleting it would leave the conclusion with no
 * support and make the system look as though it invented the claim. "An issue outliving its
 * evidence keeps its conclusions with `detached` references" (spec, assumptions).
 *
 * Per tenant, taking a `TenantContext` like every other read; bounded to `limit` records a run,
 * oldest expiry first, so a large backlog is worked through over successive runs rather than in
 * one pass that outlives the queue's wall-clock budget. Anything that is not "already gone or
 * already cited" is collected and the rest of the batch still runs; the job then fails with all of
 * them (`AggregateError`), the same shape as the staleness sweep.
 */
export async function applyEvidenceRetention(
  store: RetentionStore,
  context: TenantContext,
  now: Date,
  limit: number,
): Promise<RetentionResult> {
  const expired = await store.findExpired(scope(context, { now, limit }));
  let purged = 0;
  let detached = 0;
  let skipped = 0;
  const failures: unknown[] = [];
  for (const record of expired) {
    try {
      if (record.referenced) {
        await store.detach(scope(context, { id: record.id }));
        detached += 1;
      } else if (await store.purge(scope(context, { id: record.id, now }))) {
        purged += 1;
      } else {
        skipped += 1;
      }
    } catch (error) {
      if (error instanceof NotFoundError) skipped += 1;
      else failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `evidence retention: ${failures.length} of ${expired.length} records failed (${purged} purged, ${detached} detached, ${skipped} skipped)`,
    );
  }
  return { purged, detached, skipped };
}
