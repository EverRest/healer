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

/** The tenant's current epoch, read `FOR SHARE` — the one place a guarded write reads it under lock
 *  (approval request/resolve, decision consume). A revocation's bump is an UPDATE of this row, so
 *  it waits for every transaction that read the epoch here and cannot commit between the read and
 *  the write it guards. A tenant with no row yet would have nothing to lock and the first
 *  revocation's INSERT would not be blocked, so the row is ensured first at epoch 0 (no revocation
 *  yet; `bumpAutonomyEpochInTx` takes it 0 -> 1). `ON CONFLICT DO NOTHING` also waits for an
 *  uncommitted first-revocation insert and then reads it. */
export async function readEpochForShare(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<bigint> {
  await tx.$executeRaw`
    INSERT INTO "policy"."autonomy_epoch" (tenant_id, epoch, bumped_at, bumped_by, bump_reason)
    VALUES (${tenantId}::uuid, 0, now(), 'system', 'initial row')
    ON CONFLICT (tenant_id) DO NOTHING`;
  const rows = await tx.$queryRaw<{ epoch: bigint }[]>`
    SELECT epoch FROM "policy"."autonomy_epoch"
    WHERE tenant_id = ${tenantId}::uuid
    FOR SHARE`;
  return rows[0]?.epoch ?? 0n;
}
