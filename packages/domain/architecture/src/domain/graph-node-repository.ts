import type { TenantScoped } from '@healer/shared';

export interface RenamedGraphNode {
  readonly id: string;
  readonly naturalKey: string;
}

/**
 * The repository surface T010 needs: renaming keeps the same `id` (R-12) — never delete+create,
 * which would discard confirmation, drift history and every evidence reference pointing at this
 * node. Throws `GraphConcurrencyError` when a concurrent rename of the same node wins the race.
 */
export interface GraphNodeRepository {
  renameNaturalKey(
    where: TenantScoped<{ readonly id: string }>,
    newNaturalKey: string,
  ): Promise<RenamedGraphNode>;
}
