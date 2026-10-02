import { HealerError, NotFoundError, type TenantScoped } from '@healer/shared';
import { Prisma, type PrismaClient } from '@healer/prisma-client';
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
import { provenanceBaseConfidence } from '../domain/confidence.js';
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
}

/**
 * True only for a P2002 on `graph_version`'s own `(tenant_id, version)` unique index — never for
 * any other constraint this transaction's writes can violate (same technique and same review
 * precedent as `prisma-policy-ruleset-repository.ts`'s `isRulesetVersionOrDigestConflict`:
 * `error.meta` for a Postgres unique violation carries `{ modelName, target }`, so checking
 * `modelName` first already disambiguates the table, and the column check pins it to this one
 * index rather than some future second one on `graph_version`).
 */
function isGraphVersionConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const meta = error.meta as
    { readonly modelName?: unknown; readonly target?: unknown } | undefined;
  if (meta?.modelName !== 'GraphVersion') return false;
  const target = meta.target;
  return Array.isArray(target) && target.includes('tenant_id') && target.includes('version');
}

function toDecisionInput(row: DraftItemRow): DraftItemForDecision {
  return {
    id: row.id,
    op: row.op as DraftItemForDecision['op'],
    targetNodeId: row.target_node_id,
    targetEdgeId: row.target_edge_id,
    proposed: row.proposed as DraftItemForDecision['proposed'],
    current: row.current,
    observationRef: row.observation_ref,
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
    SELECT id, op, target_node_id, target_edge_id, proposed, current, state, observation_ref, proposal_digest
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
  constructor(private readonly prisma: PrismaClient) {
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
            after: applied.after,
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
      throw error;
    }
  }

  /** Writes one decided item's graph effect and returns what the caller needs for the
   *  `draft_item` backfill and audit entry — split out of `confirmDraftItems` to keep that
   *  method's own body a plain loop over "apply, then record" rather than a five-way inline
   *  branch. */
  private async applyDecision(
    tx: Prisma.TransactionClient,
    tenantId: string,
    version: number,
    actorRef: string,
    decision: AppliedDraftItemDecision,
    mintId: () => string,
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
          confidence: provenanceBaseConfidence(CONFIRMED_PROVENANCE),
          state: 'confirmed',
          actorRef,
          validFromVersion: version,
          validToVersion: OPEN_VERSION,
        },
      });
      await createAttrRow(tx, tenantId, decision.nodeId, decision.attributes as NodeAttributes);
      return {
        nodeId: decision.nodeId,
        targetType: 'graph_node',
        after: { name: decision.name, attributes: decision.attributes },
      };
    }

    if (decision.kind === 'add_edge') {
      await tx.graphEdge.create({
        data: {
          id: decision.edgeId,
          tenantId,
          fromNodeId: decision.fromNodeId,
          toNodeId: decision.toNodeId,
          edgeType: decision.edgeType,
          layer: decision.layer,
          provenance: CONFIRMED_PROVENANCE,
          strength: provenanceStrength(CONFIRMED_PROVENANCE),
          confidence: provenanceBaseConfidence(CONFIRMED_PROVENANCE),
          state: 'confirmed',
          validFromVersion: version,
          validToVersion: OPEN_VERSION,
        },
      });
      await tx.edgeProvenance.create({
        data: {
          id: mintId(),
          tenantId,
          edgeId: decision.edgeId,
          provenance: CONFIRMED_PROVENANCE,
          strength: provenanceStrength(CONFIRMED_PROVENANCE),
          confidence: provenanceBaseConfidence(CONFIRMED_PROVENANCE),
          // No adapter produced this row — a human confirmation is the contributing "source"
          // (data-model.md flags `edge_provenance` has no `actor_ref` column; these two string
          // constants are this package's stand-in until that's resolved — see QUESTIONS.md).
          adapterKey: 'human',
          adapterVersion: 'confirmation',
        },
      });
      return {
        edgeId: decision.edgeId,
        targetType: 'graph_edge',
        after: {
          from: decision.fromNodeId,
          to: decision.toNodeId,
          edgeType: decision.edgeType,
          layer: decision.layer,
        },
      };
    }

    if (decision.kind === 'modify_attributes') {
      await tx.graphNode.update({
        where: { id_tenantId: { id: decision.nodeId, tenantId } },
        data: {
          name: decision.name,
          provenance: CONFIRMED_PROVENANCE,
          strength: provenanceStrength(CONFIRMED_PROVENANCE),
          confidence: provenanceBaseConfidence(CONFIRMED_PROVENANCE),
          actorRef,
        },
      });
      await updateAttrRow(tx, tenantId, decision.nodeId, decision.attributes as NodeAttributes);
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
