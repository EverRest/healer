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
            // T026 review) under SERIALIZABLE: a guarded UPDATE alone, even with the read inside
            // the same transaction, measurably let two racing writers both through in this
            // repository's own earlier testing there.
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
