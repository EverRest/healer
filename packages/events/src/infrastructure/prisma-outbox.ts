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

/**
 * The drain side (`drain()` in `outbox.ts`) — tenant-agnostic on purpose: draining is a
 * background job walking every tenant's unpublished events, never scoped to one caller's
 * `TenantContext` (there is no "current tenant" for a worker that exists to publish for all of
 * them). Tenant isolation for the outbox is enforced at the write path (`insertOutbox` above,
 * called from within a tenant-scoped repository operation), not the drain path.
 */
export class PrismaOutboxStore implements OutboxStore {
  constructor(private readonly prisma: PrismaClient) {}

  async claimUnpublished(limit: number): Promise<OutboxRecord[]> {
    const rows = await this.prisma.outbox.findMany({
      where: { publishedAt: null },
      orderBy: [{ occurredAt: 'asc' }],
      take: limit,
    });
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      subjectId: row.subjectId,
      correlationId: row.correlationId,
      payload: row.payload as Readonly<Record<string, unknown>>,
      occurredAt: row.occurredAt,
      ...(row.publishedAt ? { publishedAt: row.publishedAt } : {}),
      attempts: row.attempts,
      ...(row.lastError ? { lastError: row.lastError } : {}),
    }));
  }

  async markPublished(id: string, at: Date): Promise<void> {
    await this.prisma.outbox.update({ where: { id }, data: { publishedAt: at } });
  }

  async recordFailure(id: string, error: string): Promise<void> {
    await this.prisma.outbox.update({
      where: { id },
      data: { attempts: { increment: 1 }, lastError: error },
    });
  }
}
