import { Prisma, type PrismaClient } from '@healer/prisma-client';
import type { OutboxRecord, OutboxStore, OutboxTransaction } from '../outbox.js';

/**
 * The outbox's first real backing store (001 T013) — 012 T012 built only the pure logic.
 * `PrismaOutboxTransaction` wraps whichever transaction client is already open for the mutation
 * being recorded, so `insertOutbox` writes into that same transaction rather than opening its
 * own — the property `outbox.ts`'s own doc comment exists to guarantee.
 */
export class PrismaOutboxTransaction implements OutboxTransaction {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async insertOutbox(record: OutboxRecord): Promise<void> {
    await this.tx.outbox.create({
      data: {
        id: record.id,
        tenantId: record.tenantId,
        name: record.name,
        subjectId: record.subjectId,
        correlationId: record.correlationId,
        payload: record.payload as Prisma.InputJsonValue,
        occurredAt: record.occurredAt,
        publishedAt: record.publishedAt ?? null,
        attempts: record.attempts,
        lastError: record.lastError ?? null,
      },
    });
  }
}

// A crashed worker's claim never gets released — after this long since `claimed_at`, the row is
// treated as abandoned and becomes claimable again, not permanently stuck.
const CLAIM_TIMEOUT_SQL = "interval '5 minutes'";

/** Raw `$queryRaw` rows are the real column names (snake_case), never Prisma's mapped field
 * names — this is the one place that boundary is crossed, so it is the one place that maps it. */
interface RawOutboxRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly name: string;
  readonly subject_id: string;
  readonly correlation_id: string;
  readonly payload: unknown;
  readonly occurred_at: Date;
  readonly published_at: Date | null;
  readonly attempts: number;
  readonly last_error: string | null;
}

function toOutboxRecord(row: RawOutboxRow): OutboxRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    subjectId: row.subject_id,
    correlationId: row.correlation_id,
    payload: row.payload as Readonly<Record<string, unknown>>,
    occurredAt: row.occurred_at,
    ...(row.published_at ? { publishedAt: row.published_at } : {}),
    attempts: row.attempts,
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}

/**
 * The drain side (`drain()` in `outbox.ts`) — tenant-agnostic on purpose: draining is a
 * background job walking every tenant's unpublished events, never scoped to one caller's
 * `TenantContext` (there is no "current tenant" for a worker that exists to publish for all of
 * them). Tenant isolation for the outbox is enforced at the write path (`insertOutbox` above,
 * called from within a tenant-scoped repository operation), not the drain path.
 */
export class PrismaOutboxStore implements OutboxStore {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * `SELECT ... FOR UPDATE SKIP LOCKED` inside the claiming `UPDATE`, not a plain `findMany`
   * (review finding): an unlocked read let two concurrent drain workers claim and publish the
   * same batch. Ordered by `attempts` first, `occurred_at` second — not `occurred_at` alone — so
   * a permanently-failing event sinks behind fresher ones instead of blocking every event behind
   * it forever (review finding, reproduced: the oldest row reached 5 attempts while the next row
   * was never tried, with the default 100-row batch big enough to starve every tenant if 100
   * events happened to be unpublishable at once).
   */
  async claimUnpublished(limit: number): Promise<OutboxRecord[]> {
    const rows = await this.prisma.$queryRaw<RawOutboxRow[]>`
      UPDATE "events"."outbox"
      SET claimed_at = now()
      WHERE id IN (
        SELECT id FROM "events"."outbox"
        WHERE published_at IS NULL
          AND (claimed_at IS NULL OR claimed_at < now() - ${Prisma.raw(CLAIM_TIMEOUT_SQL)})
        ORDER BY attempts ASC, occurred_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, tenant_id, name, subject_id, correlation_id, payload, occurred_at,
                published_at, attempts, last_error
    `;
    return rows.map(toOutboxRecord);
  }

  async markPublished(id: string, at: Date): Promise<void> {
    await this.prisma.outbox.update({ where: { id }, data: { publishedAt: at } });
  }

  async recordFailure(id: string, error: string): Promise<void> {
    // Clears the claim too: this worker is done with this attempt, and the row should be
    // reclaimable immediately — the `attempts` ordering above is what deprioritises it, not a
    // timer this failure would otherwise have to wait out.
    await this.prisma.outbox.update({
      where: { id },
      data: { attempts: { increment: 1 }, lastError: error, claimedAt: null },
    });
  }
}
