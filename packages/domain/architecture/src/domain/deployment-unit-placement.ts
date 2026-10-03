import type { NodeKind } from './graph-vocabulary.js';

/**
 * T051 (spec edge case): a deployment unit seen at runtime with no matching code component — a
 * third-party sidecar — becomes an `external` component that `deploys` to it. The result type has
 * no repository and no `built_from` edge, so force-fitting it to a repository is not expressible.
 * Whether a code component matched is the caller's (adapter's) finding, passed in as its natural
 * key. Edge endpoints carry their node KIND so the edge can be checked with `validateEdge` from the
 * placement output itself. The external component reuses the unit's natural key: kinds are
 * distinct node rows and `natural_key` is a per-kind matching key, not identity (R-12).
 */
export interface UnplacedDeploymentUnit {
  readonly naturalKey: string;
  readonly name: string;
}

export interface EdgeEndpoint {
  readonly kind: NodeKind;
  readonly naturalKey: string;
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
      readonly deploys: { readonly from: EdgeEndpoint; readonly to: EdgeEndpoint };
    };

const blank = (s: string): boolean => s.trim().length === 0;

export function placeDeploymentUnit(
  unit: UnplacedDeploymentUnit,
  matchedComponentNaturalKey: string | null,
): DeploymentUnitPlacement {
  if (blank(unit.naturalKey) || blank(unit.name))
    throw new Error('deployment unit needs a non-empty natural key and name');
  if (matchedComponentNaturalKey !== null) {
    if (blank(matchedComponentNaturalKey))
      throw new Error('matched component natural key must be non-empty (pass null for no match)');
    return { kind: 'matched_component', componentNaturalKey: matchedComponentNaturalKey };
  }
  return {
    kind: 'external_component',
    component: {
      naturalKey: unit.naturalKey,
      name: unit.name,
      componentType: 'external',
      characteristics: ['third_party'],
    },
    deploys: {
      from: { kind: 'component', naturalKey: unit.naturalKey },
      to: { kind: 'deployment_unit', naturalKey: unit.naturalKey },
    },
  };
}
