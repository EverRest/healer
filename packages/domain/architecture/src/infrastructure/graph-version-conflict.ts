import { Prisma } from '@healer/prisma-client';

/**
 * True only for a P2002 on `graph_version`'s own `(tenant_id, version)` unique index — never for
 * any other constraint this transaction's writes can violate (same technique and same review
 * precedent as `prisma-policy-ruleset-repository.ts`'s `isRulesetVersionOrDigestConflict`:
 * `error.meta` for a Postgres unique violation carries `{ modelName, target }`, so checking
 * `modelName` first already disambiguates the table, and the column check pins it to this one
 * index rather than some future second one on `graph_version`).
 */
export function isGraphVersionConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const meta = error.meta as
    { readonly modelName?: unknown; readonly target?: unknown } | undefined;
  if (meta?.modelName !== 'GraphVersion') return false;
  const target = meta.target;
  return Array.isArray(target) && target.includes('tenant_id') && target.includes('version');
}
