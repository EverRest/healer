import { HealerError, NotFoundError, type TenantId, type TenantScoped } from '@healer/shared';
import { Prisma, isConcurrencyConflict, type PrismaClient } from '@healer/prisma-client';
import { enqueue, PrismaOutboxTransaction } from '@healer/events';
import {
  decideDraftItemApplication,
  type AppliedDraftItemDecision,
  type DraftItemDecision,
  type DraftItemForDecision,
  type LiveGraphSnapshot,
} from '../domain/apply-draft-item.js';
import { GRAPH_CONFIRM_CAPABILITY } from '../domain/capabilities.js';
import type { ConfirmedNode } from '../domain/confirmed-graph-snapshot.js';
import { HUMAN_CONFIDENCE_BASE } from '../domain/edge-confidence.js';
import type {
  ConfirmDraftItemsInput,
  ConfirmDraftItemsResult,
  ConfirmedItemResult,
  DraftReviewRepository,
  RejectDraftItemsInput,
  RejectDraftItemsResult,
} from '../domain/draft-review-repository.js';
import { graphVersionPublishedEvent } from '../domain/events.js';
import { GraphConcurrencyError } from '../domain/graph-concurrency-error.js';
import type { NewGraphAuditEntry } from '../domain/graph-audit-entry.js';
import { mintNodeId } from '../domain/node-identity.js';
import { nodeRefKey } from '../domain/node-key.js';
import { DISCOVERY_NODE_KIND_LAYER } from '../domain/node-kind-layer.js';
import type { NodeAttributes } from '../domain/proposed-payload.js';
import { provenanceStrength } from '../domain/provenance-strength.js';
import {
  defaultCharacteristicVocabulary,
  type CharacteristicVocabulary,
} from '../domain/characteristics.js';
import { applyAddEdgeDecision } from './confirm-add-edge.js';
import {
  auditAfterWithCollision,
  collisionsForNewComponents,
  newComponentIdsOf,
} from './confirm-natural-key-collisions.js';
import { createAttrRow, updateAttrRow } from './graph-node-attr-rows.js';
import { loadLiveGraphSnapshot } from './load-live-graph-snapshot.js';
import { recordGraphAuditEntry } from './record-graph-audit-entry.js';

const OPEN_VERSION = 2147483647;
/** The provenance a human confirmation stamps the resulting row with (FR-007: ties with
 *  `derived_from_trace` for second-strongest) — never the discovered item's own class, which the
 *  confirmation supersedes. */
const CONFIRMED_PROVENANCE = 'human_confirmed' as const;

const OP_ORDER: Readonly<Record<string, number>> = {
  add_node: 0,
  add_edge: 1,
  modify_attributes: 2,
  mark_removed: 3,
};

interface DraftItemRow {
  readonly id: string;
  readonly op: string;
  readonly target_node_id: string | null;
  readonly target_edge_id: string | null;
  readonly proposed: unknown;
  readonly current: unknown | null;
  readonly state: string;
  readonly observation_ref: string | null;
  readonly proposal_digest: string;
  readonly provenance: string;
}

import { isGraphVersionConflict } from './graph-version-conflict.js';

function toDecisionInput(row: DraftItemRow): DraftItemForDecision {
  return {
    id: row.id,
    op: row.op as DraftItemForDecision['op'],
    targetNodeId: row.target_node_id,
    targetEdgeId: row.target_edge_id,
    proposed: row.proposed as DraftItemForDecision['proposed'],
    current: row.current,
    observationRef: row.observation_ref,
    provenance: row.provenance as DraftItemForDecision['provenance'],
  };
}

/** Locks (`FOR UPDATE`, `ORDER BY id` to avoid a deadlock against a concurrent batch touching an
 *  overlapping id set in a different order) and returns the exact draft items this call named —
 *  shared by `confirmDraftItems`/`rejectDraftItems`. Throws when any id does not exist under this
 *  draft/tenant, or is no longer `proposed` (already decided by an earlier call). */
async function lockProposedItems(
  tx: Prisma.TransactionClient,
  tenantId: string,
  draftId: string,
  itemIds: readonly string[],
): Promise<DraftItemRow[]> {
  const sortedIds = [...itemIds].sort();
  const rows = await tx.$queryRaw<DraftItemRow[]>`
    SELECT id, op, target_node_id, target_edge_id, proposed, current, state, observation_ref, proposal_digest,
           provenance::text AS provenance
    FROM "architecture"."draft_item"
    WHERE id = ANY(${sortedIds}::uuid[]) AND tenant_id = ${tenantId}::uuid AND draft_id = ${draftId}::uuid
    ORDER BY id
    FOR UPDATE
  `;
  if (rows.length !== itemIds.length) throw new NotFoundError('DraftItem');
  const notProposed = rows.filter((r) => r.state !== 'proposed');
  if (notProposed.length > 0) {
    throw new HealerError(
      'CONFLICT',
      `draft item(s) already decided: ${notProposed.map((r) => r.id).join(', ')}`,
    );
  }
  return rows;
}

/** One applied decision's graph-row id, targetType and before/after payload — what the per-item
 *  audit entry and the `draft_item` backfill (`target_node_id`/`target_edge_id` on a confirmed
 *  `add_*`) both need, computed once per decision instead of re-derived at each use. */
interface AppliedWrite {
  readonly nodeId?: string;
  readonly edgeId?: string;
  readonly targetType: 'graph_node' | 'graph_edge';
  readonly after: unknown;
}

/**
 * T026's write surface: one transaction per call. `confirmDraftItems` mints at most one
 * `graph_version`; `rejectDraftItems` mints none (see the domain interface's own doc comment).
 */
export class PrismaDraftReviewRepository implements DraftReviewRepository {
  constructor(
    private readonly prisma: PrismaClient,
    // Phase 5 hook (T044): the open `characteristics` vocabulary, parsed once at the composition
    // root via `parseCharacteristicVocabulary` — defaulted here so every existing test construction
    // site keeps compiling; `apps/api/src/main.ts` passes the real one explicitly.
    private readonly vocabulary: CharacteristicVocabulary = defaultCharacteristicVocabulary(),
  ) {
    // `scripts/gates/graph-confirm-capability.mjs` (T015) expects the confirm-shaped infra
    // handler in this package to reference `GRAPH_CONFIRM_CAPABILITY` — a drift signal, not a
    // second enforcement point. The real gate is `requireHumanReviewActor` (FR-010,
    // `application/require-human-review-actor.ts`), which runs before any method here is ever
    // reached; this class performs no capability lookup itself because no credential registry
    // exists yet to look one up against (`capabilities.ts`'s own doc comment).
    void GRAPH_CONFIRM_CAPABILITY;
  }

  async recordAuditEntry(where: TenantScoped<NewGraphAuditEntry>): Promise<void> {
    await recordGraphAuditEntry(this.prisma, where);
  }

  async confirmDraftItems(
    where: TenantScoped<ConfirmDraftItemsInput>,
  ): Promise<ConfirmDraftItemsResult> {
    const { tenantId, draftId, itemIds, actorRef, reason } = where;
    if (itemIds.length === 0) {
      throw new HealerError('VALIDATION', 'confirmDraftItems requires at least one item id');
    }
    const now = where.now ?? new Date();
    const mintId = () => mintNodeId(now.getTime());

    try {
      return await this.prisma.$transaction(async (tx) => {
        const draft = await tx.discoveryDraft.findUnique({
          where: { id_tenantId: { id: draftId, tenantId } },
        });
        if (draft === null) throw new NotFoundError('DiscoveryDraft');

        const rows = await lockProposedItems(tx, tenantId, draftId, itemIds);
        const items = rows.map(toDecisionInput).sort((a, b) => OP_ORDER[a.op]! - OP_ORDER[b.op]!);
        const targetNodeIds = items
          .map((i) => i.targetNodeId)
          .filter((v): v is string => v !== null);
        const targetEdgeIds = items
          .map((i) => i.targetEdgeId)
          .filter((v): v is string => v !== null);
        const snapshot = await loadLiveGraphSnapshot(tx, tenantId, targetNodeIds, targetEdgeIds);

        // Simulate every decision first, feeding each `add_node`'s minted id forward so a
        // same-batch `add_edge` can resolve against it — nothing is written to the database
        // until every decision in the batch is known, and none of them is `superseded`.
        const live: LiveGraphSnapshot = {
          nodesByKey: new Map(snapshot.nodesByKey),
          nodesById: new Map(snapshot.nodesById),
          edgeKeys: snapshot.edgeKeys,
          edgesById: snapshot.edgesById,
        };
        const decided: {
          readonly item: DraftItemForDecision;
          readonly decision: DraftItemDecision;
        }[] = [];
        for (const item of items) {
          const decision = decideDraftItemApplication(item, live, mintId);
          decided.push({ item, decision });
          if (decision.kind === 'add_node') {
            const node: ConfirmedNode = {
              id: decision.nodeId,
              nodeKind: decision.nodeKind,
              naturalKey: decision.naturalKey,
              name: decision.name,
              attributes: decision.attributes as NodeAttributes,
            };
            (live.nodesByKey as Map<string, ConfirmedNode>).set(nodeRefKey(node), node);
            (live.nodesById as Map<string, ConfirmedNode>).set(node.id, node);
          }
        }

        const superseded = decided
          .filter((d) => d.decision.kind === 'superseded')
          .map((d) => d.item.id);
        if (superseded.length > 0) {
          throw new HealerError(
            'DRAFT_ITEM_SUPERSEDED',
            'draft item target changed since the run',
            {
              itemIds: superseded,
            },
          );
        }

        const maxVersion = await tx.graphVersion.aggregate({
          where: { tenantId },
          _max: { version: true },
        });
        const version = (maxVersion._max.version ?? 0) + 1;
        const versionId = mintId();
        await tx.graphVersion.create({
          data: {
            id: versionId,
            tenantId,
            version,
            mintedBy: 'confirmation',
            actorRef,
            draftId,
            note: reason,
          },
        });

        const newComponentIds = newComponentIdsOf(decided.map((d) => d.decision));
        const collisions = await collisionsForNewComponents(tx, tenantId, newComponentIds);
        const confirmedItems: ConfirmedItemResult[] = [];
        for (const { item, decision } of decided) {
          // Unreachable: `superseded.length > 0` above already threw and rolled back the
          // transaction if any decision in this batch were `superseded`. The narrowing lets
          // `applyDecision`'s parameter type exclude that member instead of re-checking it.
          if (decision.kind === 'superseded') continue;
          const applied = await this.applyDecision(
            tx,
            tenantId,
            version,
            actorRef,
            decision,
            mintId,
            draft.runId,
            now,
          );
          confirmedItems.push({
            itemId: item.id,
            ...(applied.nodeId !== undefined ? { nodeId: applied.nodeId } : {}),
            ...(applied.edgeId !== undefined ? { edgeId: applied.edgeId } : {}),
          });

          await tx.draftItem.update({
            where: { id: item.id },
            data: {
              state: 'confirmed',
              decidedBy: actorRef,
              decidedAt: now,
              ...(applied.nodeId !== undefined ? { targetNodeId: applied.nodeId } : {}),
              ...(applied.edgeId !== undefined ? { targetEdgeId: applied.edgeId } : {}),
            },
          });

          await recordGraphAuditEntry(tx, {
            id: mintId(),
            tenantId,
            actorType: 'human',
            actorRef,
            action: 'architecture.draft_item.confirm',
            targetType: applied.targetType,
            targetId: applied.nodeId ?? applied.edgeId!,
            reason,
            evidenceIds: item.observationRef !== null ? [item.observationRef] : [],
            outcome: 'ok',
            before: item.current,
            // Surfaced, never merged (T052): a newly confirmed component that shares a natural key
            // with another confirmed component is recorded in its own audit entry for the human.
            after: auditAfterWithCollision(applied.after, applied.nodeId, collisions),
            graphVersion: version,
          });
        }

        await enqueue(
          new PrismaOutboxTransaction(tx),
          graphVersionPublishedEvent(tenantId, {
            versionId,
            version,
            mintedBy: 'confirmation',
            actorRef,
            changedElementCounts: { confirmed: confirmedItems.length },
          }),
        );

        return { version, confirmedItems };
      });
    } catch (error) {
      if (isGraphVersionConflict(error)) throw new GraphConcurrencyError('GraphVersion');
      // `mergeObservationInTx` (C-87's machine-row half, called inside this same transaction)
      // raises the same raw serialization/deadlock failures `PrismaEdgeProvenanceRepository`'s
      // own public method translates for its callers — translate it here too, since this call
      // site bypasses that wrapper on purpose (004 reconciliation batch (b)).
      if (isConcurrencyConflict(error)) throw new GraphConcurrencyError('GraphEdge');
      throw error;
    }
  }

  /** Writes one decided item's graph effect and returns what the caller needs for the
   *  `draft_item` backfill and audit entry — split out of `confirmDraftItems` to keep that
   *  method's own body a plain loop over "apply, then record" rather than a five-way inline
   *  branch. */
  private async applyDecision(
    tx: Prisma.TransactionClient,
    tenantId: TenantId,
    version: number,
    actorRef: string,
    decision: AppliedDraftItemDecision,
    mintId: () => string,
    runId: string,
    now: Date,
  ): Promise<AppliedWrite> {
    if (decision.kind === 'add_node') {
      await tx.graphNode.create({
        data: {
          id: decision.nodeId,
          tenantId,
          nodeKind: decision.nodeKind,
          layer: DISCOVERY_NODE_KIND_LAYER[decision.nodeKind],
          name: decision.name,
          naturalKey: decision.naturalKey,
          provenance: CONFIRMED_PROVENANCE,
          strength: provenanceStrength(CONFIRMED_PROVENANCE),
          confidence: HUMAN_CONFIDENCE_BASE[CONFIRMED_PROVENANCE],
          state: 'confirmed',
          actorRef,
          validFromVersion: version,
          validToVersion: OPEN_VERSION,
        },
      });
      await createAttrRow(
        tx,
        tenantId,
        decision.nodeId,
        decision.attributes as NodeAttributes,
        this.vocabulary,
      );
      return {
        nodeId: decision.nodeId,
        targetType: 'graph_node',
        after: { name: decision.name, attributes: decision.attributes },
      };
    }

    if (decision.kind === 'add_edge') {
      const applied = await applyAddEdgeDecision(
        tx,
        tenantId,
        version,
        actorRef,
        decision,
        mintId,
        runId,
        now,
      );
      return { edgeId: applied.edgeId, targetType: 'graph_edge', after: applied.after };
    }

    if (decision.kind === 'modify_attributes') {
      await tx.graphNode.update({
        where: { id_tenantId: { id: decision.nodeId, tenantId } },
        data: {
          name: decision.name,
          provenance: CONFIRMED_PROVENANCE,
          strength: provenanceStrength(CONFIRMED_PROVENANCE),
          confidence: HUMAN_CONFIDENCE_BASE[CONFIRMED_PROVENANCE],
          actorRef,
        },
      });
      await updateAttrRow(
        tx,
        tenantId,
        decision.nodeId,
        decision.attributes as NodeAttributes,
        this.vocabulary,
      );
      return {
        nodeId: decision.nodeId,
        targetType: 'graph_node',
        after: { name: decision.name, attributes: decision.attributes },
      };
    }

    if (decision.kind === 'mark_removed_node') {
      await tx.graphNode.update({
        where: { id_tenantId: { id: decision.nodeId, tenantId } },
        data: { validToVersion: version - 1 },
      });
      return { nodeId: decision.nodeId, targetType: 'graph_node', after: null };
    }

    await tx.graphEdge.update({
      where: { id_tenantId: { id: decision.edgeId, tenantId } },
      data: { validToVersion: version - 1 },
    });
    return { edgeId: decision.edgeId, targetType: 'graph_edge', after: null };
  }

  async rejectDraftItems(
    where: TenantScoped<RejectDraftItemsInput>,
  ): Promise<RejectDraftItemsResult> {
    const { tenantId, draftId, itemIds, actorRef, reason } = where;
    if (itemIds.length === 0) {
      throw new HealerError('VALIDATION', 'rejectDraftItems requires at least one item id');
    }
    const now = where.now ?? new Date();

    return this.prisma.$transaction(async (tx) => {
      const draft = await tx.discoveryDraft.findUnique({
        where: { id_tenantId: { id: draftId, tenantId } },
      });
      if (draft === null) throw new NotFoundError('DiscoveryDraft');

      const rows = await lockProposedItems(tx, tenantId, draftId, itemIds);
      for (const row of rows) {
        // FR-011: future runs filter against this. `upsert` is the no-op a retry or an
        // already-independently-rejected identical proposal needs — reject never fails on a
        // digest collision.
        await tx.proposalRejection.upsert({
          where: { tenantId_proposalDigest: { tenantId, proposalDigest: row.proposal_digest } },
          create: {
            tenantId,
            proposalDigest: row.proposal_digest,
            rejectedBy: actorRef,
            rejectedAt: now,
            reason,
          },
          update: {},
        });
        await tx.draftItem.update({
          where: { id: row.id },
          data: { state: 'rejected', decidedBy: actorRef, decidedAt: now },
        });
        await recordGraphAuditEntry(tx, {
          id: mintNodeId(now.getTime()),
          tenantId,
          actorType: 'human',
          actorRef,
          action: 'architecture.draft_item.reject',
          targetType: 'draft_item',
          targetId: row.id,
          reason,
          evidenceIds: row.observation_ref !== null ? [row.observation_ref] : [],
          outcome: 'ok',
          before: row.proposed,
          after: null,
        });
      }

      return { rejectedItemIds: [...itemIds] };
    });
  }
}
