import type { Prisma } from '@healer/prisma-client';
import { HealerError } from '@healer/shared';
import type { CharacteristicVocabulary } from '../domain/characteristics.js';
import {
  validateComponentAttr,
  validateDeploymentUnitAttr,
  validateRepositoryAttr,
} from '../domain/kind-attributes.js';
import type { NodeAttributes } from '../domain/proposed-payload.js';

/** Split out of `prisma-draft-review-repository.ts` to keep that file under the lint line limit
 *  (same reason `mark-removed.ts` was split out of `diff-builder.ts`) — the kind-attribute table
 *  a confirmed node's `NodeAttributes` maps to, and the two things T026 ever does to one: create
 *  it alongside a new `graph_node` row (`add_node`), or update it in place (`modify_attributes`).
 *  Two separate calls rather than a nested Prisma `create`/`update` through the relation: the
 *  nested-write input for a composite-keyed one-to-one relation is ambiguous about whether
 *  `tenantId` is auto-derived from the parent or must be repeated, and a plain second call makes
 *  that question moot.
 *
 * Phase 5 hook (T044 "Pending Phase 3: ... the confirmation write path calling
 * validateComponentAttr before saveComponentAttr"): every write here now goes through
 * `kind-attributes.ts`'s validators first, fails closed on a rejection — unknown keys, an
 * out-of-vocabulary characteristic, an unclosed enum value — rather than persisting whatever
 * `diff-builder.ts` happened to propose unchecked. */

function failed(errors: readonly string[]): never {
  throw new HealerError('VALIDATION', `invalid node attributes: ${errors.join('; ')}`);
}

export async function createAttrRow(
  tx: Prisma.TransactionClient,
  tenantId: string,
  nodeId: string,
  attributes: NodeAttributes,
  vocabulary: CharacteristicVocabulary,
): Promise<void> {
  if ('componentType' in attributes) {
    const validation = validateComponentAttr(
      attributes as unknown as Record<string, unknown>,
      vocabulary,
    );
    if (!validation.ok) failed(validation.errors);
    await tx.componentAttr.create({
      data: {
        nodeId,
        tenantId,
        componentType: validation.value.componentType,
        characteristics: [...validation.value.characteristics],
        ownerRef: validation.value.ownerRef,
      },
    });
    return;
  }
  if ('runtimeKind' in attributes) {
    const validation = validateDeploymentUnitAttr(attributes as unknown as Record<string, unknown>);
    if (!validation.ok) failed(validation.errors);
    await tx.deploymentUnitAttr.create({
      data: {
        nodeId,
        tenantId,
        environment: validation.value.environment,
        runtimeKind: validation.value.runtimeKind,
        runtimeRef: validation.value.runtimeRef,
        currentVersion: validation.value.currentVersion,
        lastDeployedAt:
          validation.value.lastDeployedAt === null
            ? null
            : new Date(validation.value.lastDeployedAt),
      },
    });
    return;
  }
  const validation = validateRepositoryAttr(attributes as unknown as Record<string, unknown>);
  if (!validation.ok) failed(validation.errors);
  await tx.repositoryAttr.create({
    data: {
      nodeId,
      tenantId,
      vcs: validation.value.vcs,
      projectRef: validation.value.projectRef,
      defaultBranch: validation.value.defaultBranch,
    },
  });
}

export async function updateAttrRow(
  tx: Prisma.TransactionClient,
  tenantId: string,
  nodeId: string,
  attributes: NodeAttributes,
  vocabulary: CharacteristicVocabulary,
): Promise<void> {
  if ('componentType' in attributes) {
    const validation = validateComponentAttr(
      attributes as unknown as Record<string, unknown>,
      vocabulary,
    );
    if (!validation.ok) failed(validation.errors);
    await tx.componentAttr.update({
      where: { nodeId_tenantId: { nodeId, tenantId } },
      data: {
        componentType: validation.value.componentType,
        characteristics: [...validation.value.characteristics],
        ownerRef: validation.value.ownerRef,
      },
    });
    return;
  }
  if ('runtimeKind' in attributes) {
    const validation = validateDeploymentUnitAttr(attributes as unknown as Record<string, unknown>);
    if (!validation.ok) failed(validation.errors);
    await tx.deploymentUnitAttr.update({
      where: { nodeId_tenantId: { nodeId, tenantId } },
      data: {
        environment: validation.value.environment,
        runtimeKind: validation.value.runtimeKind,
        runtimeRef: validation.value.runtimeRef,
        currentVersion: validation.value.currentVersion,
        lastDeployedAt:
          validation.value.lastDeployedAt === null
            ? null
            : new Date(validation.value.lastDeployedAt),
      },
    });
    return;
  }
  const validation = validateRepositoryAttr(attributes as unknown as Record<string, unknown>);
  if (!validation.ok) failed(validation.errors);
  await tx.repositoryAttr.update({
    where: { nodeId_tenantId: { nodeId, tenantId } },
    data: {
      vcs: validation.value.vcs,
      projectRef: validation.value.projectRef,
      defaultBranch: validation.value.defaultBranch,
    },
  });
}
