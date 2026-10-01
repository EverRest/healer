import type { TenantScoped } from '@healer/shared';
import type { AbsenceEvidenceCandidate, DraftItemCandidate } from './diff-builder.js';
import type { ConfirmedGraphSnapshot } from './confirmed-graph-snapshot.js';
import type { DiscoverySourceReasonCode, DiscoverySourceStatus } from './discovery-batch.js';

export interface NewDiscoveryRun {
  readonly id: string;
  readonly trigger: 'onboarding' | 'scheduled' | 'manual' | 'post_deploy';
  readonly runnerId: string;
  readonly startedAt: Date;
}

export interface DiscoveryRun {
  readonly id: string;
  readonly baseVersion: number;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
}

/** What a received shape becomes in `evidence.evidence` (plan "Evidence for discovery") — one
 *  row per shape, `type = 'graph_fact'`, written by the step that received it, never by a later
 *  one (001 FR-008). */
export interface GraphFactEvidence {
  readonly id: string;
  readonly sourceSystem: string;
  readonly sourceLabel: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly observedAt: Date;
}

export interface CollectionGapEvidence {
  readonly id: string;
  readonly sourceSystem: string;
  readonly sourceLabel: string;
  readonly what: string;
  readonly why: string;
  readonly observedAt: Date;
}

export interface SourceOutcomeRow {
  readonly sourceKey: string;
  readonly status: DiscoverySourceStatus;
  readonly reasonCode: DiscoverySourceReasonCode | null;
  readonly itemCount: number;
  readonly durationMs: number;
}

export interface IngestBatchWriteInput {
  readonly runId: string;
  readonly baseVersion: number;
  readonly outcome: 'complete' | 'partial' | 'failed';
  readonly adapterVersions: Readonly<Record<string, string>>;
  readonly sourceOutcomes: readonly SourceOutcomeRow[];
  readonly graphFacts: readonly GraphFactEvidence[];
  readonly collectionGaps: readonly CollectionGapEvidence[];
  readonly absenceEvidence: readonly AbsenceEvidenceCandidate[];
  readonly items: readonly DraftItemCandidate[];
}

export interface IngestedDraft {
  readonly draftId: string;
  readonly state: 'open' | 'applied' | 'abandoned';
  readonly proposalsCount: number;
  readonly itemIds: readonly string[];
}

/**
 * The write surface T035's write path needs, plus the two reads the diff builder (pure) is fed
 * from — Prisma stays in `infrastructure/` (backend-nestjs.md); `application/` depends on this
 * interface only.
 */
export interface DiscoveryRepository {
  createRun(input: TenantScoped<NewDiscoveryRun>): Promise<DiscoveryRun>;
  loadConfirmedSnapshot(
    where: TenantScoped<{ readonly baseVersion: number }>,
  ): Promise<ConfirmedGraphSnapshot>;
  loadRejectedDigests(where: TenantScoped<object>): Promise<ReadonlySet<string>>;
  /**
   * One transaction: evidence rows (graph_fact, collection_gap, absence), the draft and its
   * items, the run's own finishing update, source outcome rows, and the `DiscoveryDraftProposed`
   * outbox event (plan "Evidence for discovery", "The draft as a diff"). Idempotent: a run whose
   * `finished_at` is already set returns the existing draft untouched and writes nothing new.
   */
  ingestBatch(where: TenantScoped<IngestBatchWriteInput>): Promise<IngestedDraft | null>;
}
