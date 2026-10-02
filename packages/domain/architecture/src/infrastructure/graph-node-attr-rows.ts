import type { Prisma } from '@healer/prisma-client';
import type { NodeAttributes } from '../domain/proposed-payload.js';

/** Split out of `prisma-draft-review-repository.ts` to keep that file under the lint line limit
 *  (same reason `mark-removed.ts` was split out of `diff-builder.ts`) — the kind-attribute table
 *  a confirmed node's `NodeAttributes` maps to, and the two things T026 ever does to one: create
 *  it alongside a new `graph_node` row (`add_node`), or update it in place (`modify_attributes`).
 *  Two separate calls rather than a nested Prisma `create`/`update` through the relation: the
 *  nested-write input for a composite-keyed one-to-one relation is ambiguous about whether
 *  `tenantId` is auto-derived from the parent or must be repeated, and a plain second call makes
 *  that question moot. */

export async function createAttrRow(
  tx: Prisma.TransactionClient,
  tenantId: string,
  nodeId: string,
  attributes: NodeAttributes,
): Promise<void> {
  if ('componentType' in attributes) {
    await tx.componentAttr.create({
      data: {
        nodeId,
        tenantId,
        componentType: attributes.componentType,
        characteristics: [...attributes.characteristics],
        ownerRef: attributes.ownerRef,
      },
    });
    return;
  }
  if ('runtimeKind' in attributes) {
    await tx.deploymentUnitAttr.create({
      data: {
        nodeId,
        tenantId,
        environment: attributes.environment,
        runtimeKind: attributes.runtimeKind,
        runtimeRef: attributes.runtimeRef,
        currentVersion: attributes.currentVersion,
        lastDeployedAt:
          attributes.lastDeployedAt === null ? null : new Date(attributes.lastDeployedAt),
      },
    });
    return;
  }
  await tx.repositoryAttr.create({
    data: {
      nodeId,
      tenantId,
      vcs: attributes.vcs,
      projectRef: attributes.projectRef,
      defaultBranch: attributes.defaultBranch,
    },
  });
}

export async function updateAttrRow(
  tx: Prisma.TransactionClient,
  tenantId: string,
  nodeId: string,
  attributes: NodeAttributes,
): Promise<void> {
  if ('componentType' in attributes) {
    await tx.componentAttr.update({
      where: { nodeId_tenantId: { nodeId, tenantId } },
      data: {
        componentType: attributes.componentType,
        characteristics: [...attributes.characteristics],
        ownerRef: attributes.ownerRef,
      },
    });
    return;
  }
  if ('runtimeKind' in attributes) {
    await tx.deploymentUnitAttr.update({
      where: { nodeId_tenantId: { nodeId, tenantId } },
      data: {
        environment: attributes.environment,
        runtimeKind: attributes.runtimeKind,
        runtimeRef: attributes.runtimeRef,
        currentVersion: attributes.currentVersion,
        lastDeployedAt:
          attributes.lastDeployedAt === null ? null : new Date(attributes.lastDeployedAt),
      },
    });
    return;
  }
  await tx.repositoryAttr.update({
    where: { nodeId_tenantId: { nodeId, tenantId } },
    data: {
      vcs: attributes.vcs,
      projectRef: attributes.projectRef,
      defaultBranch: attributes.defaultBranch,
    },
  });
}
