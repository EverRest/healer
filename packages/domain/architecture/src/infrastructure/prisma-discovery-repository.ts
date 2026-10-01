import { createHash } from 'node:crypto';
import type { TenantScoped } from '@healer/shared';
import { Prisma, type PrismaClient } from '@healer/prisma-client';
import { enqueue, PrismaOutboxTransaction } from '@healer/events';
import type { ConfirmedGraphSnapshot } from '../domain/confirmed-graph-snapshot.js';
import type { DraftItemOp } from '../domain/diff-builder.js';
import {
  DISCOVERY_EVIDENCE_EXPIRES_AT,
  DISCOVERY_EVIDENCE_STEP,
} from '../domain/discovery-evidence.js';
import { discoveryDraftProposedEvent } from '../domain/events.js';
import type {
  DiscoveryRepository,
  DiscoveryRun,
  IngestBatchWriteInput,
  IngestedDraft,
  NewDiscoveryRun,
} from '../domain/discovery-repository.js';
import type { DiscoveryNodeKind, NodeAttributes } from '../domain/proposed-payload.js';
import type { GraphEdgeType } from '../domain/closed-vocabularies.js';
import type { GraphLayer } from '../domain/provenance.js';

/** Deterministic draft id from its run (one draft per run, data-model.md) — a retried ingest
 *  computes the identical id, which is what makes a retry idempotent even if the `finished_at`
 *  fast-path below were ever bypassed. */
function deterministicDraftId(tenantId: string, runId: string): string {
  const hex = createHash('sha256').update(`draft|${tenantId}|${runId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Deterministic draft item id from its draft and digest — two items with the same digest in one
 *  draft are, by construction, "the same structural proposal" (the diff builder already dedupes
 *  them before this point), so collapsing their id too is not a second, independent guarantee. */
function deterministicDraftItemId(draftId: string, digest: string): string {
  const hex = createHash('sha256').update(`draft-item|${draftId}|${digest}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

interface AttrRow {
  readonly componentAttr: {
    componentType: string;
    characteristics: string[];
    ownerRef: string | null;
  } | null;
  readonly deploymentUnitAttr: {
    environment: string;
    runtimeKind: string;
    runtimeRef: string;
    currentVersion: string | null;
    lastDeployedAt: Date | null;
  } | null;
  readonly repositoryAttr: { projectRef: string; defaultBranch: string; vcs: string } | null;
}

/** Reconstructs the one kind attribute row a confirmed node actually has into the same
 *  `NodeAttributes` shape the diff builder compares against a freshly-normalised candidate
 *  (`attribute-normalisation.ts`) — `defaultBranch`/`headSha` are repository-only fields Prisma's
 *  generated type knows nothing about elsewhere, so this is the one place the three kind attr
 *  tables and the domain's `NodeAttributes` union meet. */
function attributesFromRow(row: AttrRow): NodeAttributes {
  if (row.componentAttr !== null) {
    const { componentType, characteristics, ownerRef } = row.componentAttr;
    return { componentType, characteristics, ownerRef } as NodeAttributes;
  }
  if (row.deploymentUnitAttr !== null) {
    const { environment, runtimeKind, runtimeRef, currentVersion, lastDeployedAt } =
      row.deploymentUnitAttr;
    return {
      environment,
      runtimeKind,
      runtimeRef,
      currentVersion,
      lastDeployedAt: lastDeployedAt?.toISOString() ?? null,
    } as NodeAttributes;
  }
  const { projectRef, defaultBranch } = row.repositoryAttr!;
  return { vcs: 'gitlab', projectRef, defaultBranch } as NodeAttributes;
}

/**
 * T035's write path (plus the two reads the pure diff builder needs). One transaction for
 * `ingestBatch` — evidence rows, source outcomes, the run's finishing update, the draft and its
 * items, and the `DiscoveryDraftProposed` outbox event (plan "Evidence for discovery").
 */
export class PrismaDiscoveryRepository implements DiscoveryRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createRun(input: TenantScoped<NewDiscoveryRun>): Promise<DiscoveryRun> {
    const max = await this.prisma.graphVersion.aggregate({
      where: { tenantId: input.tenantId },
      _max: { version: true },
    });
    const baseVersion = max._max.version ?? 0;
    const row = await this.prisma.discoveryRun.create({
      data: {
        id: input.id,
        tenantId: input.tenantId,
        baseVersion,
        trigger: input.trigger,
        runnerId: input.runnerId,
        startedAt: input.startedAt,
      },
    });
    return {
      id: row.id,
      baseVersion: row.baseVersion,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    };
  }

  async loadConfirmedSnapshot(
    where: TenantScoped<{ readonly baseVersion: number }>,
  ): Promise<ConfirmedGraphSnapshot> {
    const { tenantId, baseVersion } = where;
    const nodeRows = await this.prisma.graphNode.findMany({
      where: {
        tenantId,
        state: 'confirmed',
        nodeKind: { in: ['component', 'deployment_unit', 'repository'] },
        validFromVersion: { lte: baseVersion },
        validToVersion: { gte: baseVersion },
      },
      include: { componentAttr: true, deploymentUnitAttr: true, repositoryAttr: true },
    });
    const nodes = nodeRows.map((row) => ({
      id: row.id,
      nodeKind: row.nodeKind as DiscoveryNodeKind,
      naturalKey: row.naturalKey,
      name: row.name,
      attributes: attributesFromRow(row),
    }));

    const edgeRows = await this.prisma.graphEdge.findMany({
      where: {
        tenantId,
        state: 'confirmed',
        validFromVersion: { lte: baseVersion },
        validToVersion: { gte: baseVersion },
      },
      include: { fromNode: true, toNode: true, provenanceRows: { select: { adapterKey: true } } },
    });
    const edges = edgeRows.map((row) => ({
      id: row.id,
      from: {
        nodeKind: row.fromNode.nodeKind as DiscoveryNodeKind,
        naturalKey: row.fromNode.naturalKey,
      },
      to: { nodeKind: row.toNode.nodeKind as DiscoveryNodeKind, naturalKey: row.toNode.naturalKey },
      edgeType: row.edgeType as GraphEdgeType,
      layer: row.layer as GraphLayer,
      contributingAdapterKeys: [...new Set(row.provenanceRows.map((p) => p.adapterKey))],
    }));

    return { nodes, edges };
  }

  async loadRejectedDigests(where: TenantScoped<object>): Promise<ReadonlySet<string>> {
    const rows = await this.prisma.proposalRejection.findMany({
      where: { tenantId: where.tenantId },
      select: { proposalDigest: true },
    });
    return new Set(rows.map((r) => r.proposalDigest));
  }

  async ingestBatch(where: TenantScoped<IngestBatchWriteInput>): Promise<IngestedDraft | null> {
    return this.prisma.$transaction(async (tx) => {
      const run = await tx.discoveryRun.findUniqueOrThrow({
        where: { id_tenantId: { id: where.runId, tenantId: where.tenantId } },
      });
      // Idempotent retry (plan "Architecture of a run"): a batch for a run already finished is a
      // no-op that returns the existing draft untouched, rather than writing a second time.
      if (run.finishedAt !== null) {
        const draft = await tx.discoveryDraft.findFirst({
          where: { runId: where.runId, tenantId: where.tenantId },
        });
        if (draft === null) return null; // the original ingest was `failed` — no draft to return
        const items = await tx.draftItem.findMany({
          where: { draftId: draft.id, tenantId: where.tenantId },
        });
        return {
          draftId: draft.id,
          state: draft.state,
          proposalsCount: draft.proposalsCount ?? 0,
          itemIds: items.map((i) => i.id),
        };
      }

      if (where.graphFacts.length > 0) {
        await tx.evidence.createMany({
          data: where.graphFacts.map((f) => ({
            id: f.id,
            tenantId: where.tenantId,
            issueId: null,
            type: 'graph_fact',
            sourceSystem: f.sourceSystem,
            sourceRef: where.runId,
            sourceLabel: f.sourceLabel,
            payload: f.payload as Prisma.InputJsonValue,
            producedByStep: DISCOVERY_EVIDENCE_STEP,
            observedAt: f.observedAt,
            expiresAt: DISCOVERY_EVIDENCE_EXPIRES_AT,
          })),
          skipDuplicates: true,
        });
      }
      if (where.collectionGaps.length > 0) {
        await tx.evidence.createMany({
          data: where.collectionGaps.map((g) => ({
            id: g.id,
            tenantId: where.tenantId,
            issueId: null,
            type: 'collection_gap',
            sourceSystem: g.sourceSystem,
            sourceRef: where.runId,
            sourceLabel: g.sourceLabel,
            payload: {
              kind: 'collection_gap',
              what: g.what,
              why: g.why,
              withheldByRedaction: false,
            },
            producedByStep: DISCOVERY_EVIDENCE_STEP,
            observedAt: g.observedAt,
            expiresAt: DISCOVERY_EVIDENCE_EXPIRES_AT,
          })),
          skipDuplicates: true,
        });
      }
      if (where.absenceEvidence.length > 0) {
        await tx.evidence.createMany({
          data: where.absenceEvidence.map((a) => ({
            id: a.id,
            tenantId: where.tenantId,
            issueId: null,
            type: 'graph_fact',
            sourceSystem: a.sourceSystem,
            sourceRef: where.runId,
            sourceLabel: a.sourceLabel,
            payload: a.payload as Prisma.InputJsonValue,
            producedByStep: DISCOVERY_EVIDENCE_STEP,
            observedAt: new Date(),
            expiresAt: DISCOVERY_EVIDENCE_EXPIRES_AT,
          })),
          skipDuplicates: true,
        });
      }

      for (const outcome of where.sourceOutcomes) {
        await tx.discoverySourceOutcome.upsert({
          where: { runId_sourceKey: { runId: where.runId, sourceKey: outcome.sourceKey } },
          create: {
            runId: where.runId,
            tenantId: where.tenantId,
            sourceKey: outcome.sourceKey,
            status: outcome.status,
            reasonCode: outcome.reasonCode,
            itemCount: outcome.itemCount,
            durationMs: outcome.durationMs,
          },
          update: {
            status: outcome.status,
            reasonCode: outcome.reasonCode,
            itemCount: outcome.itemCount,
            durationMs: outcome.durationMs,
          },
        });
      }

      const nodesProposed = where.items.filter((i) => i.op === 'add_node').length;
      const edgesProposed = where.items.filter((i) => i.op === 'add_edge').length;
      await tx.discoveryRun.update({
        where: { id_tenantId: { id: where.runId, tenantId: where.tenantId } },
        data: {
          finishedAt: new Date(),
          outcome: where.outcome,
          adapterVersions: where.adapterVersions as Prisma.InputJsonValue,
          nodesProposed,
          edgesProposed,
        },
      });

      if (where.outcome === 'failed') return null; // FR-023/plan: no draft is written

      const draftId = deterministicDraftId(where.tenantId, where.runId);
      await tx.discoveryDraft.upsert({
        where: { id_tenantId: { id: draftId, tenantId: where.tenantId } },
        create: {
          id: draftId,
          tenantId: where.tenantId,
          runId: where.runId,
          baseVersion: where.baseVersion,
          state: 'open',
          proposalsCount: where.items.length,
        },
        update: {},
      });

      const itemIds = where.items.map((item) =>
        deterministicDraftItemId(draftId, item.proposalDigest),
      );
      if (where.items.length > 0) {
        await tx.draftItem.createMany({
          data: where.items.map((item, i) => ({
            id: itemIds[i]!,
            tenantId: where.tenantId,
            draftId,
            op: item.op,
            targetNodeId: item.targetNodeId,
            targetEdgeId: item.targetEdgeId,
            proposed: item.proposed as unknown as Prisma.InputJsonValue,
            current:
              item.current === null ? Prisma.DbNull : (item.current as Prisma.InputJsonValue),
            proposalDigest: item.proposalDigest,
            provenance: item.provenance,
            strength: item.strength,
            confidence: item.confidence,
            observationRef: item.observationRef,
            state: 'proposed',
          })),
          skipDuplicates: true,
        });
      }

      const countsByOp: Record<DraftItemOp, number> = {
        add_node: 0,
        add_edge: 0,
        modify_attributes: 0,
        mark_removed: 0,
      };
      for (const item of where.items) countsByOp[item.op] += 1;
      // Requires an active correlation scope — the caller's job (`withCorrelation`), same
      // convention as `PrismaPolicyDecisionRepository`: a repository does not invent one.
      await enqueue(
        new PrismaOutboxTransaction(tx),
        discoveryDraftProposedEvent(where.tenantId, {
          draftId,
          runId: where.runId,
          baseVersion: where.baseVersion,
          countsByOp,
        }),
      );

      return { draftId, state: 'open', proposalsCount: where.items.length, itemIds };
    });
  }
}
