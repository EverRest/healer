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
import { compareStrongestFirst } from '../domain/strongest-provenance.js';
import { toReadEnvelope, type ReadEnvelope } from '../domain/read-envelope.js';

const OPEN = 2147483647;
const MAX_SMALLINT = 32767;

type Tx = Prisma.TransactionClient;
type NodeRow = Prisma.GraphNodeGetPayload<object>;
type EdgeRow = Prisma.GraphEdgeGetPayload<{ include: { provenanceRows: true } }>;

/** What one read resolved up front: every query of the read uses it, none re-derives it. */
interface ReadScope {
  readonly graphVersion: number;
  readonly window: Prisma.GraphNodeWhereInput & Prisma.GraphEdgeWhereInput;
  /** Set for an explicit pin: provenance recorded after this instant was not part of that version. */
  readonly mintedAt: Date | null;
}

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

function toEdgeView(row: EdgeRow, pinned: boolean): GraphEdgeView {
  const sources = [...row.provenanceRows].sort(compareStrongestFirst);
  const strongest = sources[0];
  const base = {
    id: row.id,
    fromNodeId: row.fromNodeId,
    toNodeId: row.toNodeId,
    edgeType: row.edgeType,
    layer: row.layer,
    state: row.state,
  };
  if (strongest === undefined) {
    return {
      ...base,
      observationCount: Number(row.observationCount),
      lastObservedAt: row.lastObservedAt,
      provenanceUnresolved: true,
      provenance: {
        class: row.provenance,
        strength: row.strength,
        confidence: row.confidence,
        observationRef: null,
        actorRef: null,
        contributingSources: [],
      },
    };
  }
  // A pinned read shows what the visible rows add up to — stored values, never a recompute. A live
  // read shows the edge's own denormalised columns, which `check:edge-strength-max` keeps equal.
  const lastSeen = sources
    .map((p) => p.lastObservedAt)
    .reduce<Date | null>((m, d) => (d !== null && (m === null || d > m) ? d : m), null);
  return {
    ...base,
    observationCount: pinned
      ? sources.reduce((sum, p) => sum + Number(p.observationCount), 0)
      : Number(row.observationCount),
    lastObservedAt: pinned ? lastSeen : row.lastObservedAt,
    provenanceUnresolved: false,
    provenance: {
      class: strongest.provenance,
      strength: strongest.strength,
      confidence: strongest.confidence,
      observationRef: strongest.observationRef,
      actorRef: null,
      contributingSources: sources.map((p) => ({
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

function assertInRange(name: string, value: number | undefined, min: number, max: number): void {
  if (value !== undefined && (!Number.isInteger(value) || value < min || value > max)) {
    throw new InvalidGraphFilterError(`${name} must be an integer from ${min} to ${max}`);
  }
}

export class PrismaGraphReadRepository implements GraphReadRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * One RepeatableRead transaction per read: the items, the coverage counts and the version they
   * are stated against come from one snapshot, so a concurrent confirmation cannot leave an
   * envelope describing a graph the items are not from.
   */
  private read<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn, {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  }

  /**
   * Resolves the version first. Unpinned reads sit at the tenant's current version — or, before
   * any version has been minted (current 0), at the open rows, because proposed rows carry the run's
   * base version and there is nothing to window against yet (QUESTIONS.md, 004 T036-T052). An
   * explicit pin must name a minted version: 0, a future version or an unminted gap is the caller's
   * mistake, not an empty graph.
   */
  private async resolve(tx: Tx, tenantId: string, pin: number | undefined): Promise<ReadScope> {
    assertInRange('graphVersion', pin, 1, OPEN - 1);
    const latest = await tx.graphVersion.aggregate({
      where: { tenantId },
      _max: { version: true },
    });
    const current = latest._max.version ?? 0;
    if (pin === undefined) {
      return {
        graphVersion: current,
        window:
          current === 0
            ? { validToVersion: OPEN }
            : { validFromVersion: { lte: current }, validToVersion: { gte: current } },
        mintedAt: null,
      };
    }
    const minted = await tx.graphVersion.findUnique({
      where: { tenantId_version: { tenantId, version: pin } },
    });
    if (pin > current || minted === null) {
      throw new InvalidGraphFilterError(
        `graphVersion ${pin} has not been minted (current ${current})`,
      );
    }
    return {
      graphVersion: pin,
      window: { validFromVersion: { lte: pin }, validToVersion: { gte: pin } },
      mintedAt: minted.createdAt,
    };
  }

  private async envelope<T>(
    tx: Tx,
    tenantId: string,
    at: ReadScope,
    items: T,
  ): Promise<ReadEnvelope<T>> {
    const [nodesTotal, nodesConfirmed, edgesTotal, edgesConfirmed, runs, minted] =
      await Promise.all([
        tx.graphNode.count({ where: { tenantId, ...at.window } }),
        tx.graphNode.count({ where: { tenantId, ...at.window, state: 'confirmed' } }),
        tx.graphEdge.count({ where: { tenantId, ...at.window } }),
        tx.graphEdge.count({ where: { tenantId, ...at.window, state: 'confirmed' } }),
        tx.discoveryRun.count({ where: { tenantId } }),
        tx.graphVersion.count({ where: { tenantId } }),
      ]);
    const discovered = runs > 0 || minted > 0 || nodesTotal + edgesTotal > 0;
    return toReadEnvelope(
      at.graphVersion,
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
    assertInRange('minStrength', where.minStrength, 0, MAX_SMALLINT);
    return this.read(async (tx) => {
      const at = await this.resolve(tx, where.tenantId, where.graphVersion);
      const rows = await tx.graphNode.findMany({
        where: {
          tenantId: where.tenantId,
          ...at.window,
          ...(nodeKind !== undefined ? { nodeKind } : {}),
          ...(layer !== undefined ? { layer } : {}),
          ...(state !== undefined ? { state } : {}),
          ...(where.minStrength !== undefined ? { strength: { gte: where.minStrength } } : {}),
        },
        orderBy: [{ strength: 'desc' }, { name: 'asc' }, { id: 'asc' }],
      });
      return this.envelope(tx, where.tenantId, at, rows.map(toNodeView));
    });
  }

  async getNode(
    where: TenantScoped<{ readonly id: string; readonly graphVersion?: number }>,
  ): Promise<
    ReadEnvelope<{ readonly node: GraphNodeView; readonly edges: readonly GraphEdgeView[] }>
  > {
    return this.read(async (tx) => {
      const at = await this.resolve(tx, where.tenantId, where.graphVersion);
      const row = await tx.graphNode.findFirst({
        where: { id: where.id, tenantId: where.tenantId, ...at.window },
      });
      if (row === null) throw new NotFoundError('GraphNode');
      const edges = await tx.graphEdge.findMany({
        where: {
          tenantId: where.tenantId,
          ...at.window,
          OR: [{ fromNodeId: where.id }, { toNodeId: where.id }],
        },
        include: {
          provenanceRows:
            at.mintedAt === null ? true : { where: { recordedAt: { lte: at.mintedAt } } },
        },
        orderBy: [{ strength: 'desc' }, { id: 'asc' }],
      });
      return this.envelope(tx, where.tenantId, at, {
        node: toNodeView(row),
        edges: edges.map((e) => toEdgeView(e, at.mintedAt !== null)),
      });
    });
  }
}
