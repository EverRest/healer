import { z } from 'zod';

/**
 * The four discovery shapes appended to the closed evidence set (004 FR-021, R-11, 012 T040,
 * contracts/graph-contract.md §3), in their own file only because adding them inline would push
 * `index.ts` past the 400-line lint limit. Every schema is `.strict()`, same as every shape in
 * `index.ts` — an unknown key is a validation failure, not a passthrough.
 */

// Duplicated from index.ts rather than imported: this module and index.ts import each other
// (index.ts assembles `RunnerEvidence` from these), so importing index.ts's `path`/`isoTimestamp`
// here would be a circular import evaluated at module load time — zod schema construction runs
// immediately at the top level, so the imported const would still be in its temporal dead zone.
const path = z.string().min(1);
const isoTimestamp = z.string().datetime({ offset: true });

// Mirrors packages/domain/architecture/src/domain/provenance.ts's `GraphLayer`/`ProvenanceClass`
// (FR-004, FR-005). boundary-contract has zero workspace dependencies by design (ADR 0001 — the
// execution boundary must not know about domain packages), so it cannot import that type; this is
// a deliberate, hand-kept-in-sync duplicate of the same closed list, not a second list meant to
// drift from it.
const GRAPH_LAYERS = ['code', 'runtime', 'product'] as const;
const PROVENANCE_CLASSES = [
  'human_authored',
  'human_confirmed',
  'derived_from_trace',
  'derived_from_runtime',
  'derived_from_code',
  'derived_from_config',
  'inferred_from_convention',
] as const;

export const componentCandidate = z
  .object({
    kind: z.literal('component_candidate'),
    naturalKey: z.string(),
    name: z.string(),
    componentType: z.string(),
    characteristics: z.array(z.string()),
    ownerRef: z.string().optional(),
    sourcePaths: z.array(path),
    adapterKey: z.string(),
    adapterVersion: z.string(),
  })
  .strict();

export type ComponentCandidate = z.infer<typeof componentCandidate>;

export const deploymentUnitCandidate = z
  .object({
    kind: z.literal('deployment_unit_candidate'),
    naturalKey: z.string(),
    environment: z.string(),
    runtimeKind: z.string(),
    runtimeRef: z.string(),
    currentVersion: z.string(),
    lastDeployedAt: isoTimestamp.optional(),
  })
  .strict();

export type DeploymentUnitCandidate = z.infer<typeof deploymentUnitCandidate>;

export const dependencyObservation = z
  .object({
    kind: z.literal('dependency_observation'),
    fromNaturalKey: z.string(),
    toNaturalKey: z.string(),
    edgeType: z.string(),
    layer: z.enum(GRAPH_LAYERS),
    provenance: z.enum(PROVENANCE_CLASSES),
    observationCount: z.number().int().nonnegative(),
    firstObservedAt: isoTimestamp,
    lastObservedAt: isoTimestamp,
    windowSeconds: z.number().int().nonnegative(),
  })
  .strict();

export type DependencyObservation = z.infer<typeof dependencyObservation>;

export const repositoryRef = z
  .object({
    kind: z.literal('repository_ref'),
    projectRef: z.string(),
    defaultBranch: z.string(),
    headSha: z.string(),
    componentNaturalKeys: z.array(z.string()),
  })
  .strict();

export type RepositoryRef = z.infer<typeof repositoryRef>;
