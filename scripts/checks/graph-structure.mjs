#!/usr/bin/env node
// `check:graph-structure` (004 T046, T052): continuous reconciliation against the live database —
// every open graph edge connects the node kinds its type allows (`validateEdge`), and no two open
// components share a natural key (`detectNaturalKeyCollisions`: cross-repository, same-repository
// and unrepositoried alike). This is the production reader of both rules until Phase 3's
// confirmation write path calls them at write time. Same posture as `check:ceiling`: production
// monitoring, not a release gate. Runs over every tenant as trusted internal code, one
// tenant-scoped repository call per tenant (the repository never reads across tenants).
import { OPEN_VERSION, PrismaGraphStructureRepository } from '@healer/domain-architecture';
import { TenantContext, scope } from '@healer/shared';
import { PrismaClient } from '../../prisma/generated/client/index.js';
import { isMainModule, runGate, reportAndExit } from '../lib/harness.mjs';

/**
 * @param {import('../../prisma/generated/client/index.js').PrismaClient} prisma
 * @returns {Promise<string[]>} one message per violation, each naming its tenant
 */
export async function findGraphStructureViolations(prisma) {
  const repo = new PrismaGraphStructureRepository(prisma);
  const tenants = await prisma.graphNode.findMany({
    distinct: ['tenantId'],
    select: { tenantId: true },
  });
  const messages = [];
  for (const { tenantId } of tenants) {
    const where = scope(TenantContext.forTrustedInternalUse(tenantId), {});
    for (const v of await repo.listEdgeEndpointViolations(where))
      messages.push(
        `tenant ${tenantId}: edge ${v.edge.type} ${v.edge.from} -> ${v.edge.to}: ${v.reason}`,
      );
    // An open, non-rejected edge must not point at a rejected or closed node: GetSystemContext
    // drops such an edge (counted in `excludedEdges`) and nothing else would ever say why.
    const gone = { OR: [{ state: 'rejected' }, { validToVersion: { lt: OPEN_VERSION } }] };
    const dangling = await prisma.graphEdge.findMany({
      where: {
        tenantId,
        validToVersion: OPEN_VERSION,
        state: { not: 'rejected' },
        OR: [{ fromNode: { is: gone } }, { toNode: { is: gone } }],
      },
      include: { fromNode: true, toNode: true },
    });
    for (const e of dangling)
      for (const end of [e.fromNode, e.toNode])
        if (end.state === 'rejected' || end.validToVersion < OPEN_VERSION)
          messages.push(
            `tenant ${tenantId}: dangling edge ${e.edgeType} ${e.fromNode.name} -> ${e.toNode.name}: endpoint ${end.name} is ${end.state === 'rejected' ? 'rejected' : 'closed'}`,
          );
    for (const c of await repo.listNaturalKeyCollisions(where))
      messages.push(
        `tenant ${tenantId}: natural_key ${JSON.stringify(c.naturalKey)} ${c.scope} collision between components ` +
          c.candidates.map((x) => x.componentId).join(', '),
      );
  }
  return messages;
}

/* v8 ignore start -- CLI wiring; the query it drives is proven by graph-structure.e2e.test.ts */
if (isMainModule(import.meta.url)) {
  const result = await runGate('check:graph-structure', async () => {
    const prisma = new PrismaClient();
    try {
      const violations = await findGraphStructureViolations(prisma);
      if (violations.length > 0) throw new Error(violations.join('; '));
      process.stderr.write(
        'check:graph-structure: every open edge is kind-legal and no natural_key collides\n',
      );
    } finally {
      await prisma.$disconnect();
    }
  });
  reportAndExit(result);
}
/* v8 ignore stop */
