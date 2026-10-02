/**
 * T051 (spec edge case): a deployment unit seen at runtime with no matching code component — a
 * third-party sidecar — becomes an `external` component that `deploys` to it. The result type has
 * no repository and no `built_from` edge, so force-fitting it to a repository is not expressible.
 * Whether a code component matched is the caller's (adapter's) finding, passed in as its natural key.
 */
export interface UnplacedDeploymentUnit {
  readonly naturalKey: string;
  readonly name: string;
}

export type DeploymentUnitPlacement =
  | { readonly kind: 'matched_component'; readonly componentNaturalKey: string }
  | {
      readonly kind: 'external_component';
      readonly component: {
        readonly naturalKey: string;
        readonly name: string;
        readonly componentType: 'external';
        readonly characteristics: readonly ['third_party'];
      };
      readonly deploys: { readonly fromNaturalKey: string; readonly toNaturalKey: string };
    };

export function placeDeploymentUnit(
  unit: UnplacedDeploymentUnit,
  matchedComponentNaturalKey: string | null,
): DeploymentUnitPlacement {
  if (matchedComponentNaturalKey !== null)
    return { kind: 'matched_component', componentNaturalKey: matchedComponentNaturalKey };
  return {
    kind: 'external_component',
    component: {
      naturalKey: unit.naturalKey,
      name: unit.name,
      componentType: 'external',
      characteristics: ['third_party'],
    },
    deploys: { fromNaturalKey: unit.naturalKey, toNaturalKey: unit.naturalKey },
  };
}
