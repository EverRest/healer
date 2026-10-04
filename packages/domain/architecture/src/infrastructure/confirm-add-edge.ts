import type { Prisma } from '@healer/prisma-client';
import { HealerError, type TenantId, type TenantScoped } from '@healer/shared';
import type { AppliedDraftItemDecision } from '../domain/apply-draft-item.js';
import { HUMAN_CONFIDENCE_BASE } from '../domain/edge-confidence.js';
import type { EdgeObservation } from '../domain/edge-observation.js';
import { provenanceStrength } from '../domain/provenance-strength.js';
import { validateEdge } from '../domain/structural-edges.js';
import { mergeObservationInTx } from './prisma-edge-provenance-repository.js';

const OPEN_VERSION = 2147483647;
const CONFIRMED_PROVENANCE = 'human_confirmed' as const;

/** What `applyDecision`'s caller needs back for the `draft_item` backfill and audit entry. */
export interface AppliedAddEdge {
  readonly edgeId: string;
  readonly after: {
    readonly from: string;
    readonly to: string;
    readonly edgeType: string;
    readonly layer: string;
  };
}

/**
 * Split out of `prisma-draft-review-repository.ts` to keep that file under the lint line limit
 * (same reason `graph-node-attr-rows.ts`/`mark-removed.ts` were split out).
 *
 * C-87 / 004 reconciliation batch (a)+(b): "keep the machine row" — the item's own machine
 * observation is written through `mergeObservationInTx` exactly as a real discovery merge would
 * (FR-008's append-only `edge_provenance`), *before* the separate human confirmation below. This
 * is the only door `graph_edge`/`edge_provenance` are ever written through (FR-009: a draft
 * never writes them directly).
 *
 * `adapterKey`/`adapterVersion`/`observationCount`/`lastObservedAt` are not columns on
 * `draft_item` (it stores the already-derived `provenance`/`strength`/`confidence`, not the raw
 * per-observation facts the adapter saw) — honestly labelled stand-ins, same technique this
 * handler already used for the human row below before C-87. Recorded as a judgment call in
 * QUESTIONS.md: the machine row's own confidence, derived from these stand-ins, under-counts the
 * real volume `diff-builder.ts` already derived (004 (c)) — harmless to the graph's *queried*
 * confidence, which the human row's higher strength overrides a few lines down, but imprecise for
 * anyone inspecting the machine row in isolation.
 *
 * The human confirmation half (C-87): a separate, distinct `edge_provenance` row — never through
 * `mergeObservationInTx`, whose `EdgeObservation.provenance` type statically excludes both human
 * classes (edge-observation.ts). `human_confirmed` outranks every machine class
 * (provenance-strength.ts), so `check:edge-strength-max`'s MAX resolves
 * `graph_edge.provenance`/`.strength`/`.confidence` to this row once it lands — the trigger
 * (`edge_provenance_maintain_edge_max`) handles strength/confidence; `provenance` and the edge's
 * own `state`/`actor_ref` are this function's job, same as a real merge's own provenance-resync
 * update (`mergeObservation`'s final `UPDATE ... SET provenance = (SELECT ...)`), which only runs
 * for a `mergeObservation` caller — this write path is not one.
 */
export async function applyAddEdgeDecision(
  tx: Prisma.TransactionClient,
  tenantId: TenantId,
  version: number,
  actorRef: string,
  decision: Extract<AppliedDraftItemDecision, { readonly kind: 'add_edge' }>,
  mintId: () => string,
  runId: string,
  now: Date,
): Promise<AppliedAddEdge> {
  // Phase 5 hook, wired here per the T046 note ("Pending Phase 3: the confirmation write path
  // calling validateEdge at write time") — fails closed before any write, same as every other
  // guard in this transaction, rather than persisting a structurally-impossible edge and relying
  // on `check:graph-structure` to notice it later.
  const edgeValidation = validateEdge(
    decision.edgeType,
    decision.fromNodeKind,
    decision.toNodeKind,
  );
  if (!edgeValidation.ok) {
    throw new HealerError('VALIDATION', `invalid add_edge: ${edgeValidation.reason}`);
  }

  const merged = await mergeObservationInTx(tx, {
    tenantId,
    fromNodeId: decision.fromNodeId,
    toNodeId: decision.toNodeId,
    edgeType: decision.edgeType,
    layer: decision.layer,
    provenance: decision.provenance,
    observationRef: decision.observationRef,
    adapterKey: 'discovery',
    adapterVersion: 'confirm-time-merge',
    discoveryRunId: runId,
    observationCount: 1,
    lastObservedAt: now,
    observedUntil: now,
    baseVersion: version,
  } as TenantScoped<EdgeObservation>);
  const edgeId = merged.edgeId;

  await tx.edgeProvenance.create({
    data: {
      id: mintId(),
      tenantId,
      edgeId,
      provenance: CONFIRMED_PROVENANCE,
      strength: provenanceStrength(CONFIRMED_PROVENANCE),
      confidence: HUMAN_CONFIDENCE_BASE[CONFIRMED_PROVENANCE],
      actorRef,
      adapterKey: 'human',
      adapterVersion: 'confirmation',
      validFromVersion: version,
      validToVersion: OPEN_VERSION,
    },
  });
  await tx.graphEdge.update({
    where: { id_tenantId: { id: edgeId, tenantId } },
    data: {
      provenance: CONFIRMED_PROVENANCE,
      strength: provenanceStrength(CONFIRMED_PROVENANCE),
      confidence: HUMAN_CONFIDENCE_BASE[CONFIRMED_PROVENANCE],
      state: 'confirmed',
      actorRef,
    },
  });
  return {
    edgeId,
    after: {
      from: decision.fromNodeId,
      to: decision.toNodeId,
      edgeType: decision.edgeType,
      layer: decision.layer,
    },
  };
}
