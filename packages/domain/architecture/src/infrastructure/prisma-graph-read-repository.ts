import { NotFoundError, type TenantScoped } from '@healer/shared';
import {
  GraphElementState,
  GraphLayer,
  GraphNodeKind,
  Prisma,
  type PrismaClient,
} from '@healer/prisma-client';
import {
  InvalidGraphFilterError,
  type GraphEdgeView,
  type GraphNodeFilter,
  type GraphNodeView,
  type GraphReadRepository,
} from '../domain/graph-read.js';
import { toReadEnvelope, type ReadEnvelope } from '../domain/read-envelope.js';

const OPEN = 2147483647;

type NodeRow = Prisma.GraphNodeGetPayload<object>;
type EdgeRow = Prisma.GraphEdgeGetPayload<{ include: { provenanceRows: true } }>;

function toNodeView(row: NodeRow): GraphNodeView {
  return {
    id: row.id,
    nodeKind: row.nodeKind,
    layer: row.layer,
    name: row.name,
    naturalKey: row.naturalKey,
    state: row.state,
    lifecycleState: row.lifecycleState,
    provenance: {
      class: row.provenance,
      strength: row.strength,
      confidence: row.confidence,
      observationRef: row.observationRef,
      actorRef: row.actorRef,
    },
    discoveryRunId: row.discoveryRunId,
  };
}

function toEdgeView(row: EdgeRow): GraphEdgeView {
  const strongest = [...row.provenanceRows].sort(
    (a, b) => b.strength - a.strength || a.recordedAt.getTime() - b.recordedAt.getTime(),
  )[0];
  return {
    id: row.id,
    fromNodeId: row.fromNodeId,
    toNodeId: row.toNodeId,
    edgeType: row.edgeType,
    layer: row.layer,
    state: row.state,
    observationCount: Number(row.observationCount),
    lastObservedAt: row.lastObservedAt,
    provenance: {
      class: row.provenance,
      strength: row.strength,
      confidence: row.confidence,
      observationRef: strongest?.observationRef ?? null,
      actorRef: null,
      contributingSources: row.provenanceRows.map((p) => ({
        class: p.provenance,
        adapterKey: p.adapterKey,
        observationRef: p.observationRef,
        strength: p.strength,
        confidence: p.confidence,
        discoveryRunId: p.discoveryRunId,
      })),
    },
  };
}

/** The closed sets are the schema's own enums — never a second hand-kept list. */
function oneOf<T extends string>(
  name: string,
  allowed: Record<string, T>,
  value?: string,
): T | undefined {
  if (value === undefined) return undefined;
  const found = Object.values(allowed).find((candidate) => candidate === value);
  if (found === undefined) {
    throw new InvalidGraphFilterError(
      `${name} must be one of ${Object.values(allowed).join(', ')}`,
    );
  }
  return found;
}

export class PrismaGraphReadRepository implements GraphReadRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** A pinned read uses the version window (R-04); an unpinned one reads the open rows. */
  private window(graphVersion: number | undefined) {
    return graphVersion === undefined
      ? { validToVersion: OPEN }
      : { validFromVersion: { lte: graphVersion }, validToVersion: { gte: graphVersion } };
  }

  private async envelope<T>(
    tenantId: string,
    graphVersion: number | undefined,
    items: T,
  ): Promise<ReadEnvelope<T>> {
    const window = this.window(graphVersion);
    const [latest, nodesTotal, nodesConfirmed, edgesTotal, edgesConfirmed, runs] =
      await Promise.all([
        this.prisma.graphVersion.aggregate({ where: { tenantId }, _max: { version: true } }),
        this.prisma.graphNode.count({ where: { tenantId, ...window } }),
        this.prisma.graphNode.count({ where: { tenantId, ...window, state: 'confirmed' } }),
        this.prisma.graphEdge.count({ where: { tenantId, ...window } }),
        this.prisma.graphEdge.count({ where: { tenantId, ...window, state: 'confirmed' } }),
        this.prisma.discoveryRun.count({ where: { tenantId } }),
      ]);
    const current = latest._max.version ?? 0;
    const discovered = runs > 0 || current > 0 || nodesTotal + edgesTotal > 0;
    return toReadEnvelope(
      graphVersion ?? current,
      discovered,
      { nodesConfirmed, nodesTotal, edgesConfirmed, edgesTotal },
      items,
    );
  }

  async listNodes(
    where: TenantScoped<GraphNodeFilter>,
  ): Promise<ReadEnvelope<readonly GraphNodeView[]>> {
    const nodeKind = oneOf('nodeKind', GraphNodeKind, where.nodeKind);
    const layer = oneOf('layer', GraphLayer, where.layer);
    const state = oneOf('state', GraphElementState, where.state);
    const rows = await this.prisma.graphNode.findMany({
      where: {
        tenantId: where.tenantId,
        ...this.window(where.graphVersion),
        ...(nodeKind !== undefined ? { nodeKind } : {}),
        ...(layer !== undefined ? { layer } : {}),
        ...(state !== undefined ? { state } : {}),
        ...(where.minStrength !== undefined ? { strength: { gte: where.minStrength } } : {}),
      },
      orderBy: [{ strength: 'desc' }, { name: 'asc' }, { id: 'asc' }],
    });
    return this.envelope(where.tenantId, where.graphVersion, rows.map(toNodeView));
  }

  async getNode(
    where: TenantScoped<{ readonly id: string; readonly graphVersion?: number }>,
  ): Promise<
    ReadEnvelope<{ readonly node: GraphNodeView; readonly edges: readonly GraphEdgeView[] }>
  > {
    const window = this.window(where.graphVersion);
    const row = await this.prisma.graphNode.findFirst({
      where: { id: where.id, tenantId: where.tenantId, ...window },
    });
    if (row === null) throw new NotFoundError('GraphNode');
    const edges = await this.prisma.graphEdge.findMany({
      where: {
        tenantId: where.tenantId,
        ...window,
        OR: [{ fromNodeId: where.id }, { toNodeId: where.id }],
      },
      include: { provenanceRows: true },
      orderBy: [{ strength: 'desc' }, { id: 'asc' }],
    });
    return this.envelope(where.tenantId, where.graphVersion, {
      node: toNodeView(row),
      edges: edges.map(toEdgeView),
    });
  }
}
