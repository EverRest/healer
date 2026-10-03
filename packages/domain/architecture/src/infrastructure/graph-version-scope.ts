import type { Prisma } from '@healer/prisma-client';

/** `valid_to_version` of a row that is still open — the schema's own sentinel, stated once. */
export const OPEN_VERSION = 2147483647;

type Tx = Prisma.TransactionClient;

export interface UnpinnedVersionScope {
  readonly graphVersion: number;
  /** Rows valid at `graphVersion` — usable as a `where` on both graph nodes and graph edges. */
  readonly window: Prisma.GraphNodeWhereInput & Prisma.GraphEdgeWhereInput;
}

/**
 * The tenant's current version and the validity window of the rows visible at it. Before any
 * version has been minted (current 0) there is nothing to window against — proposed rows carry the
 * run's base version — so the window is simply "still open" (QUESTIONS.md, 004 T036-T052). The one
 * authority for an unpinned read: `GET /graph/nodes` and `GetSystemContext` both use it.
 */
export async function unpinnedVersionScope(
  tx: Tx,
  tenantId: string,
): Promise<UnpinnedVersionScope> {
  const latest = await tx.graphVersion.aggregate({ where: { tenantId }, _max: { version: true } });
  const graphVersion = latest._max.version ?? 0;
  return {
    graphVersion,
    window:
      graphVersion === 0
        ? { validToVersion: OPEN_VERSION }
        : { validFromVersion: { lte: graphVersion }, validToVersion: { gte: graphVersion } },
  };
}
