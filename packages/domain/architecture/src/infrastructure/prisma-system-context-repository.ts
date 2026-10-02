import type { TenantScoped } from '@healer/shared';
import { Prisma, type GraphElementState, type PrismaClient } from '@healer/prisma-client';
import {
  SystemContextInvariantError,
  type SystemContext,
  type SystemContextEdge,
  type SystemContextNode,
  type SystemContextRepository,
  type VisibleElementState,
} from '../domain/system-context.js';
import { toReadEnvelope, type ReadEnvelope } from '../domain/read-envelope.js';
import { unpinnedVersionScope } from './graph-version-scope.js';

type NodeRow = Prisma.GraphNodeGetPayload<{
  include: { componentAttr: true; deploymentUnitAttr: true; repositoryAttr: true };
}>;

/** The node kinds a context lists; any other kind's edges are counted as excluded. */
const CONTEXT_KINDS = ['component', 'deployment_unit', 'repository'] as const;

/**
 * Narrows a stored state into the context's. The return type is the check: a state added to the
 * schema enum is not assignable to `VisibleElementState`, so this stops compiling until it is
 * classified. Rejected rows are filtered in the query; reaching one here is a broken invariant.
 */
function visibleState(state: GraphElementState, where: { tenantId: string; id: string }) {
  if (state === 'rejected')
    throw new SystemContextInvariantError(
      where.tenantId,
      where.id,
      'a rejected row reached the context',
    );
  return state satisfies VisibleElementState;
}

const provenanceOf = (r: { provenance: string; strength: number; confidence: number }) => ({
  class: r.provenance as SystemContextNode<unknown>['provenance']['class'],
  strength: r.strength,
  confidence: r.confidence,
});

function toNode<A>(row: NodeRow, attributes: A | null): SystemContextNode<A> {
  // The attr row is written with its node (T044); a node without one is a broken graph, not a gap.
  if (attributes === null)
    throw new SystemContextInvariantError(
      row.tenantId,
      row.id,
      `no ${row.nodeKind} attributes row`,
    );
  return {
    id: row.id,
    name: row.name,
    naturalKey: row.naturalKey,
    state: visibleState(row.state, row),
    provenance: provenanceOf(row),
    attributes,
  };
}

/**
 * Never exposes a rejected element; reads items and coverage in one snapshot (R-13). Coverage is
 * scoped to what the context lists (see `SystemContext.excludedEdges`).
 */
export class PrismaSystemContextRepository implements SystemContextRepository {
  constructor(private readonly prisma: PrismaClient) {}

  read(where: TenantScoped<object>): Promise<ReadEnvelope<SystemContext>> {
    const { tenantId } = where;
    return this.prisma.$transaction(
      async (tx) => {
        const { graphVersion, window } = await unpinnedVersionScope(tx, tenantId);
        const live = { tenantId, ...window, state: { not: 'rejected' as const } };
        const listed = { ...live, nodeKind: { in: [...CONTEXT_KINDS] } };
        const rows = await tx.graphNode.findMany({
          where: listed,
          include: { componentAttr: true, deploymentUnitAttr: true, repositoryAttr: true },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
        });
        // Relation filters, not id lists: no parameter growth with the graph's size.
        const edgeRows = await tx.graphEdge.findMany({
          where: { ...live, fromNode: { is: listed }, toNode: { is: listed } },
          orderBy: [{ edgeType: 'asc' }, { id: 'asc' }],
        });
        const [liveEdges, runs, minted] = await Promise.all([
          tx.graphEdge.count({ where: live }),
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
          state: visibleState(e.state, e),
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
          excludedEdges: liveEdges - edges.length,
        };
        const confirmed = (xs: readonly { state: string }[]) =>
          xs.filter((x) => x.state === 'confirmed').length;
        return toReadEnvelope(
          graphVersion,
          runs > 0 || minted > 0 || rows.length + liveEdges > 0,
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
