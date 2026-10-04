import { placeDeploymentUnit } from './deployment-unit-placement.js';
import type { CandidateEdge, CandidateNode } from './diff-builder.js';
import { graphFactId } from './graph-fact-id.js';
import { canonical } from './natural-key-collisions.js';
import type { ConfirmedNode } from './confirmed-graph-snapshot.js';

export interface DeploymentUnitResolutionResult {
  readonly extraNodes: readonly CandidateNode[];
  readonly extraEdges: readonly CandidateEdge[];
}

/**
 * Phase 5 hook (T051, quickstart 38): a deployment unit this run observed with no matching code
 * component becomes an `external` component that `deploys` to it, via `placeDeploymentUnit` —
 * previously built as a pure function with no caller. "Matched" means a component candidate or
 * confirmed node shares the unit's natural key (the same convention `placeDeploymentUnit`'s own
 * external path already reuses: the external component gets the unit's own natural key).
 *
 * Split out of `diff-builder.ts` to keep that file under the lint line limit (same reason
 * `mark-removed.ts`/`edge-resolution.ts` are their own modules); only type-only imports flow back.
 */
export function resolveDeploymentUnitPlacements(
  candidateNodes: readonly CandidateNode[],
  confirmedNodes: readonly ConfirmedNode[],
  deploysTargetKeys: ReadonlySet<string>,
  tenantId: string,
  runId: string,
): DeploymentUnitResolutionResult {
  // A unit some component already `deploys`-to this run is matched too — the adapter's own
  // observation is the association, not the natural-key coincidence.
  const deployed = new Set([...deploysTargetKeys].map(canonical));
  const componentKeys = new Set<string>();
  for (const n of candidateNodes) {
    if (n.ref.nodeKind === 'component') componentKeys.add(canonical(n.ref.naturalKey));
  }
  for (const n of confirmedNodes) {
    if (n.nodeKind === 'component') componentKeys.add(canonical(n.naturalKey));
  }

  const extraNodes: CandidateNode[] = [];
  const extraEdges: CandidateEdge[] = [];
  for (const unit of candidateNodes) {
    if (unit.ref.nodeKind !== 'deployment_unit') continue;
    if (componentKeys.has(canonical(unit.ref.naturalKey))) continue; // matched by key
    if (deployed.has(canonical(unit.ref.naturalKey))) continue; // matched by a deploys observation

    const placement = placeDeploymentUnit(
      { naturalKey: unit.ref.naturalKey, name: unit.name },
      null,
    );
    // Unreachable with `matchedComponentNaturalKey: null` — placeDeploymentUnit's dispatch
    // always returns `external_component` in that branch; narrows the type, not a real check.
    if (placement.kind !== 'external_component') continue;

    const observationRef = graphFactId(tenantId, runId, 'external_component', unit.ref);
    extraNodes.push({
      ref: { nodeKind: 'component', naturalKey: placement.component.naturalKey },
      name: placement.component.name,
      attributes: {
        componentType: placement.component.componentType,
        characteristics: [...placement.component.characteristics],
        ownerRef: null,
      },
      provenance: unit.provenance,
      observationRef,
    });
    extraEdges.push({
      from: { nodeKind: 'component', naturalKey: placement.deploys.from.naturalKey },
      to: { nodeKind: 'deployment_unit', naturalKey: placement.deploys.to.naturalKey },
      edgeType: 'deploys',
      layer: 'runtime',
      provenance: unit.provenance,
      observationRef,
      observation: null,
    });
  }
  return { extraNodes, extraEdges };
}
