import type { TenantScoped } from '@healer/shared';
import type { PrismaClient } from '@healer/prisma-client';
import {
  buildEvidenceGraph,
  type EvidenceGraph,
  type EvidenceGraphRepository,
} from '../domain/evidence-graph.js';
import { toDomain } from './prisma-evidence-repository.js';

/**
 * Reads the issue's evidence and its links in one tenant-scoped query and hands both to the pure
 * `buildEvidenceGraph` — the ordering lives there, not in SQL. `evidence_link`'s composite FK
 * `(evidence_id, tenant_id)` means a link can only ever sit under its own tenant's evidence.
 */
export class PrismaEvidenceGraphRepository implements EvidenceGraphRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async forIssue(where: TenantScoped<{ readonly issueId: string }>): Promise<EvidenceGraph> {
    const rows = await this.prisma.evidence.findMany({
      where: { tenantId: where.tenantId, issueId: where.issueId },
      include: { links: true },
    });
    return buildEvidenceGraph(
      rows.map(toDomain),
      rows.flatMap((row) => row.links),
    );
  }
}
