import { validateIngress } from '@healer/boundary-contract';
import { scope, type TenantContext } from '@healer/shared';
import {
  isComponentType,
  isDeploymentRuntimeKind,
  isGraphEdgeType,
} from '../domain/closed-vocabularies.js';
import type { AcceptedSourceItems } from '../domain/diff-builder.js';
import { buildDraftItems } from '../domain/diff-builder.js';
import type { AdapterConstants, DiscoveryItem, SourceResult } from '../domain/discovery-batch.js';
import type {
  CollectionGapEvidence,
  DiscoveryRepository,
  GraphFactEvidence,
  IngestedDraft,
  SourceOutcomeRow,
} from '../domain/discovery-repository.js';
import type { DiscoveryLogger } from '../domain/discovery-logger.js';
import { graphFactId } from '../domain/graph-fact-id.js';
import { downgradeForRejectedItems } from '../domain/source-outcome.js';

export interface IngestDiscoveryBatchInput {
  readonly runId: string;
  readonly baseVersion: number;
  readonly sources: readonly SourceResult[];
  readonly adapterConstants: Readonly<Record<string, AdapterConstants>>;
  readonly logger?: DiscoveryLogger;
}

/**
 * An item's declared source must be a registered adapter whose fixed `layer`/`provenance` the
 * item agrees with (plan "Ingestion rules" — the cross-check deferred since T003/T017). A
 * `dependency_observation` claiming a different `provenance`/`layer` than its adapter's constant,
 * or a `component_candidate` whose `adapterKey` names a different source, is the item an adapter
 * has no field to produce honestly — rejected here, independent of `validateEgress` already
 * having passed it on the way out.
 */
function passesAdapterCrossCheck(
  item: DiscoveryItem,
  sourceKey: string,
  constants: AdapterConstants,
): boolean {
  if (item.kind === 'component_candidate') return item.adapterKey === sourceKey;
  if (item.kind === 'dependency_observation') {
    if (item.layer === 'product') return false; // FR-013: product knowledge is human, never discovered
    return item.provenance === constants.provenance && item.layer === constants.layer;
  }
  return true; // deployment_unit_candidate / repository_ref carry no adapter-identifying field
}

/** Closed-vocabulary fields the wire types as `z.string()` (graph-contract.md §3,
 *  boundary-contract has no domain-enum dependency) — validated against this package's own
 *  closed lists; a miss is `schema_rejected`, same outcome as a cross-check failure. */
function passesClosedVocabulary(item: DiscoveryItem): boolean {
  if (item.kind === 'component_candidate') return isComponentType(item.componentType);
  if (item.kind === 'deployment_unit_candidate') return isDeploymentRuntimeKind(item.runtimeKind);
  if (item.kind === 'dependency_observation') return isGraphEdgeType(item.edgeType);
  return true;
}

function observedAtOf(item: DiscoveryItem): Date {
  return item.kind === 'dependency_observation' ? new Date(item.lastObservedAt) : new Date();
}

interface SourceIngestResult {
  readonly accepted: AcceptedSourceItems;
  readonly outcomeRow: SourceOutcomeRow;
  readonly graphFacts: readonly GraphFactEvidence[];
  readonly gaps: readonly CollectionGapEvidence[];
}

/** Review fix (#10): `anyRejected` used to collapse every rejection reason into one boolean —
 *  `validateIngress`'s own errors (field + message, never a value) were computed and then
 *  discarded. Counted per reason here so the caller can log it and the gap can say more than
 *  "something was rejected". */
interface RejectionCounts {
  ingress: number;
  crossCheck: number;
  closedVocabulary: number;
}

function totalRejections(counts: RejectionCounts): number {
  return counts.ingress + counts.crossCheck + counts.closedVocabulary;
}

function ingestOneSource(
  source: SourceResult,
  adapterConstants: Readonly<Record<string, AdapterConstants>>,
  tenantId: string,
  runId: string,
  logger: DiscoveryLogger | undefined,
): SourceIngestResult {
  const constants = adapterConstants[source.sourceKey];
  const accepted: DiscoveryItem[] = [];
  const graphFacts: GraphFactEvidence[] = [];
  const rejections: RejectionCounts = { ingress: 0, crossCheck: 0, closedVocabulary: 0 };
  const ingressErrors: string[] = [];

  for (const item of source.items) {
    const ingress = validateIngress(item);
    if (!ingress.ok) {
      rejections.ingress += 1;
      ingressErrors.push(...(ingress.errors ?? []));
      continue;
    }
    const crossCheckOk =
      constants !== undefined && passesAdapterCrossCheck(item, source.sourceKey, constants);
    if (!crossCheckOk) {
      rejections.crossCheck += 1;
      continue;
    }
    if (!passesClosedVocabulary(item)) {
      rejections.closedVocabulary += 1;
      continue;
    }
    accepted.push(item);
    graphFacts.push({
      id: graphFactId(tenantId, runId, item.kind, item),
      sourceSystem: source.sourceKey,
      sourceLabel: `${source.sourceKey} discovery run ${runId}`,
      payload: item as unknown as Readonly<Record<string, unknown>>,
      observedAt: observedAtOf(item),
    });
  }

  const rejectedCount = totalRejections(rejections);
  if (rejectedCount > 0) {
    // Never the item content — `validateIngress`'s errors are zod issue paths/messages
    // (field-level), never a payload value (security-and-tenancy.md).
    logger?.warn(
      {
        sourceKey: source.sourceKey,
        runId,
        tenantId,
        ingressRejected: rejections.ingress,
        crossCheckRejected: rejections.crossCheck,
        closedVocabularyRejected: rejections.closedVocabulary,
        ingressErrors,
      },
      'discovery source emitted items rejected at ingestion',
    );
  }

  const finalOutcome = downgradeForRejectedItems(
    { status: source.status, reasonCode: source.reasonCode },
    rejectedCount > 0,
  );
  const gaps: CollectionGapEvidence[] = source.gaps.map((gap) => ({
    // Review fix (#13): the hash used to exclude `sourceKey` — two different sources reporting
    // the identical `{what, why}` gap (plausible: two adapters hitting the same unreadable
    // vendor/ directory) collapsed into one evidence row via `skipDuplicates`, silently losing
    // one source's own gap.
    id: graphFactId(tenantId, runId, 'collection_gap', { sourceKey: source.sourceKey, ...gap }),
    sourceSystem: source.sourceKey,
    sourceLabel: `${source.sourceKey} discovery run ${runId}`,
    what: gap.what,
    why: gap.why,
    observedAt: new Date(),
  }));
  // Plan "Source outcomes": every non-`collected` source outcome produces exactly one
  // `collection_gap` evidence row naming the source and why, additional to any region gap the
  // adapter itself reported above. Review fix (#10): the why now names the rejection counts by
  // reason instead of just repeating the status/reason code the row already carries.
  if (finalOutcome.status !== 'collected') {
    const why =
      rejectedCount > 0
        ? `${finalOutcome.reasonCode ?? finalOutcome.status}: ${rejectedCount} item(s) rejected ` +
          `(ingress: ${rejections.ingress}, cross_check: ${rejections.crossCheck}, closed_vocabulary: ${rejections.closedVocabulary})`
        : (finalOutcome.reasonCode ?? finalOutcome.status);
    gaps.push({
      id: graphFactId(tenantId, runId, 'source_gap', {
        sourceKey: source.sourceKey,
        ...finalOutcome,
        rejectedCount,
      }),
      sourceSystem: source.sourceKey,
      sourceLabel: `${source.sourceKey} discovery run ${runId}`,
      what: source.sourceKey,
      why,
      observedAt: new Date(),
    });
  }

  return {
    accepted: { sourceKey: source.sourceKey, finalStatus: finalOutcome.status, items: accepted },
    outcomeRow: {
      sourceKey: source.sourceKey,
      status: finalOutcome.status,
      reasonCode: finalOutcome.reasonCode,
      itemCount: accepted.length,
      durationMs: source.durationMs,
    },
    graphFacts,
    gaps,
  };
}

/**
 * The control-plane half of ingestion (T019, T020, T023, T032, FR-027): validates ingress
 * independently of egress, cross-checks against the registered adapter, writes one `graph_fact`
 * evidence row per accepted item plus `collection_gap` rows (the adapter's own region gaps, and
 * one per non-collected source), loads the confirmed snapshot and rejection digests, runs the
 * pure diff builder, and persists everything in `repo.ingestBatch`'s one transaction. Returns
 * `null` when the run outcome is `failed` and no draft item exists to confirm — "failed if none
 * returned any item (no draft is written)" (plan "Source outcomes").
 */
export async function ingestDiscoveryBatch(
  repo: DiscoveryRepository,
  context: TenantContext,
  input: IngestDiscoveryBatchInput,
): Promise<IngestedDraft | null> {
  const perSource = input.sources.map((source) =>
    ingestOneSource(source, input.adapterConstants, context.tenantId, input.runId, input.logger),
  );

  const sourceOutcomes = perSource.map((r) => r.outcomeRow);
  const graphFacts = perSource.flatMap((r) => r.graphFacts);
  const collectionGaps = perSource.flatMap((r) => r.gaps);
  const acceptedSources = perSource.map((r) => r.accepted);
  const totalAcceptedItems = acceptedSources.reduce((sum, s) => sum + s.items.length, 0);

  // Review fix (#12): a source that was never requested (`not_attempted`) is not evidence of an
  // incomplete run the way a `partial`/`timed_out`/`unavailable` one is — "there is no skipped"
  // (data-model.md) means the operator chose not to ask, not that something went wrong. Excluding
  // it from this check is what makes `partial` mean "something that was asked for came back
  // incomplete", not "fewer sources were requested than exist".
  const attemptedOutcomes = sourceOutcomes.filter((s) => s.status !== 'not_attempted');
  const outcome: 'complete' | 'partial' | 'failed' =
    totalAcceptedItems === 0
      ? 'failed'
      : attemptedOutcomes.every((s) => s.status === 'collected')
        ? 'complete'
        : 'partial';

  const adapterVersions = Object.fromEntries(
    input.sources.map((s) => [s.sourceKey, s.adapterVersion]),
  );

  if (outcome === 'failed') {
    return repo.ingestBatch(
      scope(context, {
        runId: input.runId,
        baseVersion: input.baseVersion,
        outcome,
        adapterVersions,
        sourceOutcomes,
        graphFacts,
        collectionGaps,
        absenceEvidence: [],
        items: [],
      }),
    );
  }

  const snapshot = await repo.loadConfirmedSnapshot(
    scope(context, { baseVersion: input.baseVersion }),
  );
  const rejectedDigests = await repo.loadRejectedDigests(scope(context, {}));

  const { items, absenceEvidence, unresolvedEdges } = buildDraftItems({
    tenantId: context.tenantId,
    runId: input.runId,
    sources: acceptedSources,
    adapterConstants: input.adapterConstants,
    snapshot,
    rejectedDigests,
  });
  // Review fix (#11): `buildDraftItems` is pure and cannot log itself — this is the one call
  // site, so the count it returns is logged here rather than silently dropped.
  if (unresolvedEdges > 0) {
    input.logger?.warn(
      { runId: input.runId, tenantId: context.tenantId, unresolvedEdges },
      'discovery run proposed fewer edges than observed: some endpoints did not resolve to a known node',
    );
  }

  return repo.ingestBatch(
    scope(context, {
      runId: input.runId,
      baseVersion: input.baseVersion,
      outcome,
      adapterVersions,
      sourceOutcomes,
      graphFacts,
      collectionGaps,
      absenceEvidence,
      items,
    }),
  );
}
