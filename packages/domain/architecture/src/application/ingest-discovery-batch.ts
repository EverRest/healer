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
import { graphFactId } from '../domain/graph-fact-id.js';
import { downgradeForRejectedItems } from '../domain/source-outcome.js';

export interface IngestDiscoveryBatchInput {
  readonly runId: string;
  readonly baseVersion: number;
  readonly sources: readonly SourceResult[];
  readonly adapterConstants: Readonly<Record<string, AdapterConstants>>;
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

function ingestOneSource(
  source: SourceResult,
  adapterConstants: Readonly<Record<string, AdapterConstants>>,
  tenantId: string,
  runId: string,
): SourceIngestResult {
  const constants = adapterConstants[source.sourceKey];
  const accepted: DiscoveryItem[] = [];
  const graphFacts: GraphFactEvidence[] = [];
  let anyRejected = false;

  for (const item of source.items) {
    const ingress = validateIngress(item);
    const crossCheckOk =
      constants !== undefined && passesAdapterCrossCheck(item, source.sourceKey, constants);
    if (!ingress.ok || !crossCheckOk || !passesClosedVocabulary(item)) {
      anyRejected = true;
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

  const finalOutcome = downgradeForRejectedItems(
    { status: source.status, reasonCode: source.reasonCode },
    anyRejected,
  );
  const gaps: CollectionGapEvidence[] = source.gaps.map((gap) => ({
    id: graphFactId(tenantId, runId, 'collection_gap', gap),
    sourceSystem: source.sourceKey,
    sourceLabel: `${source.sourceKey} discovery run ${runId}`,
    what: gap.what,
    why: gap.why,
    observedAt: new Date(),
  }));
  // Plan "Source outcomes": every non-`collected` source outcome produces exactly one
  // `collection_gap` evidence row naming the source and why, additional to any region gap the
  // adapter itself reported above.
  if (finalOutcome.status !== 'collected') {
    gaps.push({
      id: graphFactId(tenantId, runId, 'source_gap', {
        sourceKey: source.sourceKey,
        ...finalOutcome,
      }),
      sourceSystem: source.sourceKey,
      sourceLabel: `${source.sourceKey} discovery run ${runId}`,
      what: source.sourceKey,
      why: finalOutcome.reasonCode ?? finalOutcome.status,
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
    ingestOneSource(source, input.adapterConstants, context.tenantId, input.runId),
  );

  const sourceOutcomes = perSource.map((r) => r.outcomeRow);
  const graphFacts = perSource.flatMap((r) => r.graphFacts);
  const collectionGaps = perSource.flatMap((r) => r.gaps);
  const acceptedSources = perSource.map((r) => r.accepted);
  const totalAcceptedItems = acceptedSources.reduce((sum, s) => sum + s.items.length, 0);

  const outcome: 'complete' | 'partial' | 'failed' =
    totalAcceptedItems === 0
      ? 'failed'
      : sourceOutcomes.every((s) => s.status === 'collected')
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

  const { items, absenceEvidence } = buildDraftItems({
    tenantId: context.tenantId,
    runId: input.runId,
    sources: acceptedSources,
    adapterConstants: input.adapterConstants,
    snapshot,
    rejectedDigests,
  });

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
