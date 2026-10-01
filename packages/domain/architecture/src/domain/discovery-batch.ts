import type {
  ComponentCandidate,
  DeploymentUnitCandidate,
  DependencyObservation,
  RepositoryRef,
} from '@healer/boundary-contract';
import type { CollectionGap } from './discovery-adapter.js';

/** 003 FR-014's six statuses and nine reason codes, reused verbatim (data-model.md) — no local
 *  set. Mirrors `prisma/schema.prisma`'s `discovery_source_status` / `discovery_source_reason_code`. */
export const DISCOVERY_SOURCE_STATUSES = [
  'collected',
  'partial',
  'unavailable',
  'timed_out',
  'withheld',
  'not_attempted',
] as const;
export type DiscoverySourceStatus = (typeof DISCOVERY_SOURCE_STATUSES)[number];

export type DiscoverySourceReasonCode =
  | 'source_unreachable'
  | 'auth_revoked'
  | 'timeout'
  | 'retention_exceeded'
  | 'capability_unavailable'
  | 'budget_exhausted'
  | 'redaction_withheld'
  | 'schema_rejected'
  | 'empty_result';

export type DiscoveryItem =
  ComponentCandidate | DeploymentUnitCandidate | DependencyObservation | RepositoryRef;

/** What one source contributed this run — what `collectDiscovery` (T021) produces per adapter,
 *  before `ingestDiscoveryBatch` (T019) may further downgrade `status`/`reasonCode` (plan
 *  "Ingestion rules": an item failing ingress/the adapter cross-check downgrades a `collected`
 *  source to `partial`/`schema_rejected`). */
export interface SourceResult {
  readonly sourceKey: string;
  readonly adapterVersion: string;
  readonly status: DiscoverySourceStatus;
  readonly reasonCode: DiscoverySourceReasonCode | null;
  readonly durationMs: number;
  /** Items that passed `validateEgress` (T021) — a failing item is never sent (graph-contract.md
   *  §3), so this array already excludes it. */
  readonly items: readonly DiscoveryItem[];
  /** Regions the adapter itself could not read (FR-023, T032) — additional to any
   *  control-plane-synthesised gap for a non-collected source (plan "Source outcomes"). */
  readonly gaps: readonly CollectionGap[];
}

/** What crosses the control/execution boundary (plan "Architecture of a run") — the only thing
 *  `ingestDiscoveryBatch` (control plane) receives from `collectDiscovery` (execution plane). */
export interface DiscoveryBatch {
  readonly runId: string;
  readonly tenantId: string;
  readonly baseVersion: number;
  readonly sources: readonly SourceResult[];
}

/** What the control plane knows about each registered adapter — passed into `ingestDiscoveryBatch`
 *  independently of the adapter instances themselves (plan "Ingestion rules": "a map `sourceKey →
 *  { version, layer, provenance }` passed in from the adapter list"), simulating that ingestion
 *  runs in a different plane from collection even though both run in-process today. */
export interface AdapterConstants {
  readonly version: string;
  readonly layer: 'code' | 'runtime' | 'product';
  readonly provenance: import('./provenance.js').ProvenanceClass;
}
