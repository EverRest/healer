import { NotFoundError, type TenantScoped } from '@healer/shared';
import { Prisma, type PrismaClient, withConcurrencyTranslation } from '@healer/prisma-client';
import { GraphConcurrencyError } from '../domain/graph-concurrency-error.js';
import type { GraphNodeRepository, RenamedGraphNode } from '../domain/graph-node-repository.js';

export class PrismaGraphNodeRepository implements GraphNodeRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async renameNaturalKey(
    where: TenantScoped<{ readonly id: string }>,
    newNaturalKey: string,
  ): Promise<RenamedGraphNode> {
    return withConcurrencyTranslation(
      () =>
        this.prisma.$transaction(
          async (tx) => {
            const current = await tx.graphNode.findUnique({
              where: { id_tenantId: { id: where.id, tenantId: where.tenantId } },
            });
            if (current === null) throw new NotFoundError('GraphNode');

            // R-12: rewrites natural_key on the SAME row — never delete+create. Guarded on the
            // natural_key just read (same technique as PrismaIssueRepository.transition(), 001
            // T026 review), under SERIALIZABLE.
            //
            // Post-review note: for *this* race shape specifically (isolated testing against
            // graph-node-rename-race.e2e.test.ts, not assumed from 001's transition() investigation
            // of a different one), the guard alone and SERIALIZABLE alone were each independently
            // sufficient to reject the loser every time; only removing both together reproduced a
            // lost update. Both are kept anyway — doubly redundant costs nothing here, and this
            // codebase has documented history (001's transition() investigation, QUESTIONS.md) of
            // Postgres-serialization-conflict intermittency that too few trials can miss, so a
            // claim about this specific interleaving is only as good as how many times it was run.
            const affected = await tx.$executeRaw`
              UPDATE "architecture"."graph_node"
              SET natural_key = ${newNaturalKey}
              WHERE id = ${where.id}::uuid AND tenant_id = ${where.tenantId}::uuid
                AND natural_key = ${current.naturalKey}
            `;
            if (affected === 0) throw new GraphConcurrencyError('GraphNode');
            return { id: where.id, naturalKey: newNaturalKey };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      () => new GraphConcurrencyError('GraphNode'),
    );
  }
}
