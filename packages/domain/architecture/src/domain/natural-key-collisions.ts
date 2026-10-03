/**
 * T052 (R-12, spec edge case): `natural_key` is a matching key, not identity. Two or more DISTINCT
 * components sharing one are surfaced as a collision for the confirmation step to disambiguate —
 * this module returns candidates only and has no merge operation, so the result cannot be turned
 * into a merged node. The `scope` says why it matters: `cross_repository` is the spec's edge case;
 * `same_repository` and `unrepositoried` duplicates are reported too, never silently dropped.
 *
 * Entries are merged by `componentId` first (one component listed once per repository is one
 * component), and keys are grouped by `trim().toLowerCase()` while the candidates keep the keys
 * as written.
 */
export interface ComponentRepositories {
  readonly componentId: string;
  readonly naturalKey: string;
  readonly repositoryIds: readonly string[];
}

export type CollisionScope = 'cross_repository' | 'same_repository' | 'unrepositoried';

export interface NaturalKeyCollision {
  /** The canonical (trimmed, lower-cased) key the group was matched on. */
  readonly naturalKey: string;
  readonly scope: CollisionScope;
  readonly candidates: readonly ComponentRepositories[];
}

const canonical = (key: string): string => key.trim().toLowerCase();

function scopeOf(group: readonly ComponentRepositories[]): CollisionScope {
  const repositories = new Set(group.flatMap((c) => c.repositoryIds));
  if (repositories.size > 1) return 'cross_repository';
  return group.some((c) => c.repositoryIds.length === 0) ? 'unrepositoried' : 'same_repository';
}

export function detectNaturalKeyCollisions(
  components: readonly ComponentRepositories[],
): NaturalKeyCollision[] {
  const byId = new Map<string, ComponentRepositories>();
  for (const c of components) {
    const seen = byId.get(c.componentId);
    byId.set(c.componentId, {
      componentId: c.componentId,
      naturalKey: seen?.naturalKey ?? c.naturalKey,
      repositoryIds: [...new Set([...(seen?.repositoryIds ?? []), ...c.repositoryIds])],
    });
  }
  const byKey = new Map<string, ComponentRepositories[]>();
  for (const c of byId.values()) {
    const key = canonical(c.naturalKey);
    byKey.set(key, [...(byKey.get(key) ?? []), c]);
  }
  const collisions: NaturalKeyCollision[] = [];
  for (const [naturalKey, group] of byKey)
    if (group.length > 1) collisions.push({ naturalKey, scope: scopeOf(group), candidates: group });
  return collisions;
}
