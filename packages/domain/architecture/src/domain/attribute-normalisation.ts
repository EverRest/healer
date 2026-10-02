import type {
  ComponentCandidate,
  DeploymentUnitCandidate,
  RepositoryRef,
} from '@healer/boundary-contract';
import { isComponentType, isDeploymentRuntimeKind } from './closed-vocabularies.js';
import type {
  ComponentAttributes,
  DeploymentUnitAttributes,
  RepositoryAttributes,
} from './proposed-payload.js';
import { sortedCharacteristics } from './proposed-payload.js';

/**
 * Turns a candidate shape into the normalised attribute bag `draft_item.proposed`/`current` carry
 * (plan "The draft as a diff"). Sorting `characteristics` is the only normalisation Phase 3 needs
 * — every other field is already a scalar. Returns `null` when the candidate's closed-vocabulary
 * string field (`componentType` / `runtimeKind`) is not one of the domain's closed values — the
 * caller treats that candidate as `schema_rejected` (plan "Ingestion rules").
 */
export function normaliseComponentAttributes(
  candidate: ComponentCandidate,
): ComponentAttributes | null {
  if (!isComponentType(candidate.componentType)) return null;
  return {
    componentType: candidate.componentType,
    characteristics: sortedCharacteristics(candidate.characteristics),
    ownerRef: candidate.ownerRef ?? null,
  };
}

export function normaliseDeploymentUnitAttributes(
  candidate: DeploymentUnitCandidate,
): DeploymentUnitAttributes | null {
  if (!isDeploymentRuntimeKind(candidate.runtimeKind)) return null;
  return {
    environment: candidate.environment,
    runtimeKind: candidate.runtimeKind,
    runtimeRef: candidate.runtimeRef,
    currentVersion: candidate.currentVersion,
    // Review fix: the confirmed side is rebuilt from a `Date` column via `.toISOString()`
    // (`prisma-discovery-repository.ts`'s `attributesFromRow`), which can differ from the wire's
    // own ISO string in millisecond formatting even for the identical instant — producing a
    // spurious `modify_attributes` on every re-run. Both sides now go through `Date.toISOString()`
    // so they compare in the one canonical format regardless of what the wire sent.
    lastDeployedAt:
      candidate.lastDeployedAt !== undefined
        ? new Date(candidate.lastDeployedAt).toISOString()
        : null,
  };
}

export function normaliseRepositoryAttributes(candidate: RepositoryRef): RepositoryAttributes {
  // `headSha` deliberately dropped here — see `RepositoryAttributes`'s doc comment.
  return {
    vcs: 'gitlab',
    projectRef: candidate.projectRef,
    defaultBranch: candidate.defaultBranch,
  };
}

/** Deep-equal over already-normalised bags — safe as a JSON-string comparison because every
 *  field is a scalar or a pre-sorted array, never a nested object whose key order could vary. */
export function sameAttributes(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
