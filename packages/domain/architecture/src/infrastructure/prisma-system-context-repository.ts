import type { TenantScoped } from '@healer/shared';
import { Prisma, type PrismaClient } from '@healer/prisma-client';
import type {
  SystemContext,
  SystemContextEdge,
  SystemContextNode,
  SystemContextRepository,
} from '../domain/system-context.js';
import { toReadEnvelope, type ReadEnvelope } from '../domain/read-envelope.js';

type NodeRow = Prisma.GraphNodeGetPayload<{
  include: { componentAttr: true; deploymentUnitAttr: true; repositoryAttr: true };
}>;

const provenanceOf = (r: { provenance: string; strength: number; confidence: number }) => ({
  class: r.provenance as SystemContextNode<unknown>['provenance']['class'],
  strength: r.strength,
  confidence: r.confidence,
});

function toNode<A>(row: NodeRow, attributes: A | null): SystemContextNode<A> {
  // The attr row is written with its node (T044); a node without one is a broken graph, not a gap.
  if (attributes === null)
    throw new Error(`graph node ${row.id} has no ${row.nodeKind} attributes`);
  return {
    id: row.id,
    name: row.name,
    naturalKey: row.naturalKey,
    state: row.state,
    provenance: provenanceOf(row),
    attributes,
  };
}

/** Never exposes a rejected element; reads items and coverage in one snapshot (R-13). */
export class PrismaSystemContextRepository implements SystemContextRepository {
  constructor(private readonly prisma: PrismaClient) {}

  read(where: TenantScoped<object>): Promise<ReadEnvelope<SystemContext>> {
    const { tenantId } = where;
    return this.prisma.$transaction(
      async (tx) => {
        const latest = await tx.graphVersion.aggregate({
          where: { tenantId },
          _max: { version: true },
        });
        const graphVersion = latest._max.version ?? 0;
        // Before any version is minted there is nothing to window against: read the open rows.
        const window =
          graphVersion === 0
            ? { validToVersion: 2147483647 }
            : { validFromVersion: { lte: graphVersion }, validToVersion: { gte: graphVersion } };
        const live = { tenantId, ...window, state: { not: 'rejected' as const } };
        const rows = await tx.graphNode.findMany({
          where: { ...live, nodeKind: { in: ['component', 'deployment_unit', 'repository'] } },
          include: { componentAttr: true, deploymentUnitAttr: true, repositoryAttr: true },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
        });
        const ids = rows.map((r) => r.id);
        const edgeRows = await tx.graphEdge.findMany({
          where: { ...live, fromNodeId: { in: ids }, toNodeId: { in: ids } },
          orderBy: [{ edgeType: 'asc' }, { id: 'asc' }],
        });
        const [runs, minted] = await Promise.all([
          tx.discoveryRun.count({ where: { tenantId } }),
          tx.graphVersion.count({ where: { tenantId } }),
        ]);
        const of = (kind: string) => rows.filter((r) => r.nodeKind === kind);
        const components = of('component').map((r) =>
          toNode(
            r,
            r.componentAttr && {
              componentType: r.componentAttr.componentType,
              characteristics: r.componentAttr.characteristics,
              ownerRef: r.componentAttr.ownerRef,
            },
          ),
        );
        const edges: SystemContextEdge[] = edgeRows.map((e) => ({
          id: e.id,
          fromNodeId: e.fromNodeId,
          toNodeId: e.toNodeId,
          edgeType: e.edgeType,
          layer: e.layer,
          state: e.state,
          provenance: provenanceOf(e),
        }));
        const items: SystemContext = {
          components,
          deploymentUnits: of('deployment_unit').map((r) =>
            toNode(
              r,
              r.deploymentUnitAttr && {
                environment: r.deploymentUnitAttr.environment,
                runtimeKind: r.deploymentUnitAttr.runtimeKind,
                runtimeRef: r.deploymentUnitAttr.runtimeRef,
                currentVersion: r.deploymentUnitAttr.currentVersion,
              },
            ),
          ),
          repositories: of('repository').map((r) =>
            toNode(
              r,
              r.repositoryAttr && {
                vcs: r.repositoryAttr.vcs,
                projectRef: r.repositoryAttr.projectRef,
                defaultBranch: r.repositoryAttr.defaultBranch,
              },
            ),
          ),
          characteristics: [
            ...new Set(components.flatMap((c) => c.attributes.characteristics)),
          ].sort(),
          edges,
        };
        const confirmed = (xs: readonly { state: string }[]) =>
          xs.filter((x) => x.state === 'confirmed').length;
        return toReadEnvelope(
          graphVersion,
          runs > 0 || minted > 0 || rows.length + edges.length > 0,
          {
            nodesConfirmed: confirmed(rows),
            nodesTotal: rows.length,
            edgesConfirmed: confirmed(edges),
            edgesTotal: edges.length,
          },
          items,
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
