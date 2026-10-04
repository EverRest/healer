import type { Prisma } from '@healer/prisma-client';
import type { TenantId } from '@healer/shared';
import {
  detectNaturalKeyCollisions,
  type ComponentRepositories,
  type NaturalKeyCollision,
} from '../domain/natural-key-collisions.js';

interface ComponentRow {
  readonly id: string;
  readonly natural_key: string;
  readonly repository_ids: string[] | null;
}

/**
 * Phase 5 hook (T052, R-12): at confirm time, every confirmed component (open row) is checked
 * against every other for a shared natural key, and the collisions naming one of this batch's
 * newly confirmed components are returned so they can be surfaced to the confirming human. Never
 * merged — `detectNaturalKeyCollisions` has no merge operation by design. The repository a
 * component belongs to is its open `built_from` edge(s), the same association the T052 detector
 * was written against.
 */
export async function collisionsForNewComponents(
  tx: Prisma.TransactionClient,
  tenantId: TenantId,
  newComponentIds: ReadonlySet<string>,
): Promise<Map<string, NaturalKeyCollision>> {
  if (newComponentIds.size === 0) return new Map();
  const rows = await tx.$queryRaw<ComponentRow[]>`
    SELECT n.id, n.natural_key, array_agg(r.id::text) FILTER (WHERE r.id IS NOT NULL) AS repository_ids
    FROM "architecture"."graph_node" n
    LEFT JOIN "architecture"."graph_edge" e
      ON e.from_node_id = n.id AND e.tenant_id = n.tenant_id AND e.edge_type = 'built_from'
     AND e.state = 'confirmed' AND e.valid_to_version = 2147483647
    LEFT JOIN "architecture"."graph_node" r
      ON r.id = e.to_node_id AND r.tenant_id = e.tenant_id AND r.node_kind = 'repository'
    WHERE n.tenant_id = ${tenantId}::uuid AND n.node_kind = 'component'
      AND n.state = 'confirmed' AND n.valid_to_version = 2147483647
    GROUP BY n.id, n.natural_key`;
  const components: ComponentRepositories[] = rows.map((r) => ({
    componentId: r.id,
    naturalKey: r.natural_key,
    repositoryIds: r.repository_ids ?? [],
  }));
  const out = new Map<string, NaturalKeyCollision>();
  for (const collision of detectNaturalKeyCollisions(components)) {
    for (const candidate of collision.candidates) {
      if (newComponentIds.has(candidate.componentId)) out.set(candidate.componentId, collision);
    }
  }
  return out;
}

/** The new-component ids of a batch's `add_node` decisions — the set collisions are checked for. */
export function newComponentIdsOf(
  decisions: readonly {
    readonly kind: string;
    readonly nodeKind?: string;
    readonly nodeId?: string;
  }[],
): Set<string> {
  return new Set(
    decisions
      .filter((d) => d.kind === 'add_node' && d.nodeKind === 'component')
      .map((d) => d.nodeId!),
  );
}

/** Adds the collision to a confirmed node's audit `after` payload — surfaced, never merged. */
export function auditAfterWithCollision(
  after: unknown,
  nodeId: string | undefined,
  collisions: ReadonlyMap<string, NaturalKeyCollision>,
): unknown {
  if (nodeId === undefined || !collisions.has(nodeId)) return after;
  return { ...(after as object), naturalKeyCollision: collisions.get(nodeId) };
}
