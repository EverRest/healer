import type { Prisma } from '@healer/prisma-client';
import type { LiveGraphSnapshot } from '../domain/apply-draft-item.js';
import type { ConfirmedEdge, ConfirmedNode } from '../domain/confirmed-graph-snapshot.js';
import { edgeKey, nodeRefKey } from '../domain/node-key.js';
import type { NodeAttributes } from '../domain/proposed-payload.js';

const OPEN_VERSION = 2147483647;

/**
 * T027/T028's rebase target, split out of `prisma-draft-review-repository.ts` to keep that file
 * under the lint line limit. `FOR UPDATE` locks exactly the live rows a batch's
 * `modify_attributes`/`mark_removed` items point at by id — the real lock the review asked for,
 * not a guarded blind update, and simple here because every row this needs already has an id to
 * lock by. The `add_node`/`add_edge` identity-collision check this snapshot also serves is
 * read-only and best-effort by contrast: there is no row to lock when none yet exists under that
 * identity — same accepted, documented limit as T052's natural-key-collision scope
 * (QUESTIONS.md).
 */
export async function loadLiveGraphSnapshot(
  tx: Prisma.TransactionClient,
  tenantId: string,
  targetNodeIds: readonly string[],
  targetEdgeIds: readonly string[],
): Promise<LiveGraphSnapshot> {
  if (targetNodeIds.length > 0) {
    await tx.$queryRaw`
      SELECT id FROM "architecture"."graph_node"
      WHERE id = ANY(${targetNodeIds}::uuid[]) AND tenant_id = ${tenantId}::uuid
      FOR UPDATE
    `;
  }
  if (targetEdgeIds.length > 0) {
    await tx.$queryRaw`
      SELECT id FROM "architecture"."graph_edge"
      WHERE id = ANY(${targetEdgeIds}::uuid[]) AND tenant_id = ${tenantId}::uuid
      FOR UPDATE
    `;
  }

  const nodeRows = await tx.graphNode.findMany({
    where: { tenantId, state: 'confirmed', validToVersion: OPEN_VERSION },
    include: { componentAttr: true, deploymentUnitAttr: true, repositoryAttr: true },
  });
  const nodesByKey = new Map<string, ConfirmedNode>();
  const nodesById = new Map<string, ConfirmedNode>();
  for (const row of nodeRows) {
    const attributes: NodeAttributes =
      row.componentAttr !== null
        ? ({
            componentType: row.componentAttr.componentType,
            characteristics: row.componentAttr.characteristics,
            ownerRef: row.componentAttr.ownerRef,
          } as NodeAttributes)
        : row.deploymentUnitAttr !== null
          ? ({
              environment: row.deploymentUnitAttr.environment,
              runtimeKind: row.deploymentUnitAttr.runtimeKind,
              runtimeRef: row.deploymentUnitAttr.runtimeRef,
              currentVersion: row.deploymentUnitAttr.currentVersion,
              lastDeployedAt: row.deploymentUnitAttr.lastDeployedAt?.toISOString() ?? null,
            } as NodeAttributes)
          : ({
              vcs: row.repositoryAttr!.vcs,
              projectRef: row.repositoryAttr!.projectRef,
              defaultBranch: row.repositoryAttr!.defaultBranch,
            } as NodeAttributes);
    const node: ConfirmedNode = {
      id: row.id,
      nodeKind: row.nodeKind as ConfirmedNode['nodeKind'],
      naturalKey: row.naturalKey,
      name: row.name,
      attributes,
    };
    nodesByKey.set(nodeRefKey(node), node);
    nodesById.set(node.id, node);
  }

  const edgeRows = await tx.graphEdge.findMany({
    where: { tenantId, state: 'confirmed', validToVersion: OPEN_VERSION },
    include: { fromNode: true, toNode: true },
  });
  const edgeKeys = new Set<string>();
  const edgesById = new Map<string, ConfirmedEdge>();
  for (const row of edgeRows) {
    const from = {
      nodeKind: row.fromNode.nodeKind as ConfirmedNode['nodeKind'],
      naturalKey: row.fromNode.naturalKey,
    };
    const to = {
      nodeKind: row.toNode.nodeKind as ConfirmedNode['nodeKind'],
      naturalKey: row.toNode.naturalKey,
    };
    const edge: ConfirmedEdge = {
      id: row.id,
      from,
      to,
      edgeType: row.edgeType as ConfirmedEdge['edgeType'],
      layer: row.layer as ConfirmedEdge['layer'],
      contributingAdapterKeys: [],
    };
    edgeKeys.add(edgeKey(from, to, edge.edgeType, edge.layer));
    edgesById.set(edge.id, edge);
  }

  return { nodesByKey, nodesById, edgeKeys, edgesById };
}
