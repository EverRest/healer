import type { Prisma } from '@healer/prisma-client';

/** T043: the one place `autonomy_epoch` is written — an atomic upsert (Postgres `INSERT ...
 *  ON CONFLICT DO UPDATE` under Prisma's `upsert`), so two concurrent revocations for the same
 *  tenant serialize on the row rather than racing a read-then-write. Shared by
 *  `PrismaAutonomyEpochRepository.bump()` (standalone, T044's tests) and
 *  `PrismaAutonomyGrantRepository.revoke()` (inside the same transaction as the grant update,
 *  T043) — one authority for the write, not two copies of the same upsert.
 *
 * Takes a plain `tenantId` rather than a branded `TenantScoped` value: this is an infra-internal
 * helper called only from inside a repository method that already received a properly scoped
 * `where` (the caller extracts the field it needs), not a domain-facing entry point — the same
 * convention `ruleRow`/`toDomain` helpers in this package's other Prisma repositories already
 * follow. */
export async function bumpAutonomyEpochInTx(
  tx: Prisma.TransactionClient,
  where: { readonly tenantId: string; readonly bumpedBy: string; readonly bumpReason: string },
  now: Date,
): Promise<bigint> {
  const row = await tx.autonomyEpoch.upsert({
    where: { tenantId: where.tenantId },
    create: {
      tenantId: where.tenantId,
      epoch: 1n,
      bumpedAt: now,
      bumpedBy: where.bumpedBy,
      bumpReason: where.bumpReason,
    },
    update: {
      epoch: { increment: 1n },
      bumpedAt: now,
      bumpedBy: where.bumpedBy,
      bumpReason: where.bumpReason,
    },
  });
  return row.epoch;
}
