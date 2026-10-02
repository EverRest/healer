/**
 * T052 (R-12, spec edge case): `natural_key` is a matching key, not identity. Two components
 * sharing one across DIFFERENT repositories are surfaced as a collision for the confirmation step
 * to disambiguate — this module returns candidates only and has no merge operation, so the
 * result cannot be turned into a merged node. Same-repository duplicates are a different defect
 * and one component built from several repositories is not a collision with itself.
 */
export interface ComponentRepositories {
  readonly componentId: string;
  readonly naturalKey: string;
  readonly repositoryIds: readonly string[];
}

export interface NaturalKeyCollision {
  readonly naturalKey: string;
  readonly candidates: readonly {
    readonly componentId: string;
    readonly repositoryIds: readonly string[];
  }[];
}

export function detectNaturalKeyCollisions(
  components: readonly ComponentRepositories[],
): NaturalKeyCollision[] {
  const byKey = new Map<string, ComponentRepositories[]>();
  for (const c of components) byKey.set(c.naturalKey, [...(byKey.get(c.naturalKey) ?? []), c]);
  const collisions: NaturalKeyCollision[] = [];
  for (const [naturalKey, group] of byKey) {
    const repositories = new Set(group.flatMap((c) => c.repositoryIds));
    if (group.length > 1 && repositories.size > 1)
      collisions.push({
        naturalKey,
        candidates: group.map(({ componentId, repositoryIds }) => ({ componentId, repositoryIds })),
      });
  }
  return collisions;
}
