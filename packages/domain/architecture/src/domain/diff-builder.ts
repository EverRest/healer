import type {
  ComponentCandidate,
  DeploymentUnitCandidate,
  RepositoryRef,
} from '@healer/boundary-contract';
import type { GraphEdgeType } from './closed-vocabularies.js';
import {
  normaliseComponentAttributes,
  normaliseDeploymentUnitAttributes,
  normaliseRepositoryAttributes,
  sameAttributes,
} from './attribute-normalisation.js';
import type { AdapterConstants, DiscoveryItem, DiscoverySourceStatus } from './discovery-batch.js';
import { baseConfidence, deriveEdgeConfidence } from './edge-confidence.js';
import { resolveEdges } from './edge-resolution.js';
import type { MachineProvenanceClass } from './edge-observation.js';
import type {
  ConfirmedEdge,
  ConfirmedGraphSnapshot,
  ConfirmedNode,
} from './confirmed-graph-snapshot.js';
import { graphFactId } from './graph-fact-id.js';
import { markRemovedEdges, markRemovedNodes } from './mark-removed.js';
import { edgeKey, nodeRefKey } from './node-key.js';
import { provenanceStrength } from './provenance-strength.js';
import type { ProvenanceClass } from './provenance.js';
import { proposalDigest } from './proposal-digest.js';
import type {
  DiscoveryNodeKind,
  NodeAttributes,
  NodeRef,
  ProposedPayload,
} from './proposed-payload.js';

export { naturalEdgeKey } from './edge-resolution.js';

export interface AcceptedSourceItems {
  readonly sourceKey: string;
  readonly finalStatus: DiscoverySourceStatus;
  readonly items: readonly DiscoveryItem[];
}

export interface BuildDraftItemsInput {
  readonly tenantId: string;
  readonly runId: string;
  readonly sources: readonly AcceptedSourceItems[];
  readonly adapterConstants: Readonly<Record<string, AdapterConstants>>;
  readonly snapshot: ConfirmedGraphSnapshot;
  readonly rejectedDigests: ReadonlySet<string>;
  /** The confidence reference instant (R-15: "against the observation window, not today") —
   *  defaults to the real clock so a caller never has to invent one; a test pins it. */
  readonly now?: Date;
}

export type DraftItemOp = ProposedPayload['op'];

export interface DraftItemCandidate {
  readonly op: DraftItemOp;
  readonly targetNodeId: string | null;
  readonly targetEdgeId: string | null;
  readonly proposed: ProposedPayload;
  readonly current: unknown | null;
  readonly proposalDigest: string;
  readonly provenance: ProvenanceClass;
  readonly strength: number;
  readonly confidence: number;
  readonly observationRef: string;
}

/** An absence fact has no boundary shape (the four shapes only declare what was observed, never
 *  what was not) — written as its own `graph_fact` evidence row directly, not through a
 *  `validateIngress`-checked payload. One per `mark_removed` item. */
export interface AbsenceEvidenceCandidate {
  readonly id: string;
  readonly sourceSystem: string;
  readonly sourceLabel: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface BuildDraftItemsResult {
  readonly items: readonly DraftItemCandidate[];
  readonly countsByOp: Readonly<Record<DraftItemOp, number>>;
  readonly absenceEvidence: readonly AbsenceEvidenceCandidate[];
  /** `dependency_observation`/`built_from` pairs whose endpoint(s) did not resolve this run
   *  (review fix #11) — the caller logs this; it is never silent. */
  readonly unresolvedEdges: number;
}

export interface CandidateNode {
  readonly ref: NodeRef;
  readonly name: string;
  readonly attributes: NodeAttributes;
  readonly provenance: ProvenanceClass;
  readonly observationRef: string;
}

export interface CandidateEdge {
  readonly from: NodeRef;
  readonly to: NodeRef;
  readonly edgeType: GraphEdgeType;
  readonly layer: 'code' | 'runtime' | 'product';
  readonly provenance: ProvenanceClass;
  readonly observationRef: string;
  /** `dependency_observation`'s own volume/recency (004 reconciliation batch (c)) — present only
   *  when the source item actually carried them; `null` for a `built_from` edge, which has none
   *  to report (R-15: derive from real fields, never invent them). */
  readonly observation: { readonly observationCount: number; readonly lastObservedAt: Date } | null;
}

/** Returns whether the item was actually kept (review fix #8): the rejection filter can no-op
 *  this call, and a caller that also writes evidence tied only to this one item (`mark_removed`'s
 *  synthetic absence fact) must not write that evidence when the item itself was dropped. */
export type Push = (
  op: DraftItemOp,
  item: Omit<DraftItemCandidate, 'op' | 'proposalDigest'>,
) => boolean;

const STRONGEST_FIRST = (a: { provenance: ProvenanceClass }, b: { provenance: ProvenanceClass }) =>
  provenanceStrength(b.provenance) - provenanceStrength(a.provenance);

/** One candidate per key — "same structural proposal from two sources in one run → one item,
 *  strongest provenance wins" (plan "The draft as a diff"). */
function dedupeByKey<T extends { provenance: ProvenanceClass }>(
  candidates: readonly T[],
  keyOf: (c: T) => string,
): Map<string, T> {
  const byKey = new Map<string, T[]>();
  for (const c of candidates) byKey.set(keyOf(c), [...(byKey.get(keyOf(c)) ?? []), c]);
  const out = new Map<string, T>();
  for (const [k, group] of byKey) out.set(k, [...group].sort(STRONGEST_FIRST)[0]!);
  return out;
}

function toCandidateNode(
  item: ComponentCandidate | DeploymentUnitCandidate | RepositoryRef,
  tenantId: string,
  runId: string,
  provenance: ProvenanceClass,
): CandidateNode | null {
  const observationRef = graphFactId(tenantId, runId, item.kind, item);
  if (item.kind === 'component_candidate') {
    const attributes = normaliseComponentAttributes(item);
    if (attributes === null) return null;
    return {
      ref: { nodeKind: 'component', naturalKey: item.naturalKey },
      name: item.name,
      attributes,
      provenance,
      observationRef,
    };
  }
  if (item.kind === 'deployment_unit_candidate') {
    const attributes = normaliseDeploymentUnitAttributes(item);
    if (attributes === null) return null;
    return {
      ref: { nodeKind: 'deployment_unit', naturalKey: item.naturalKey },
      name: item.naturalKey,
      attributes,
      provenance,
      observationRef,
    };
  }
  return {
    ref: { nodeKind: 'repository', naturalKey: item.projectRef },
    name: item.projectRef,
    attributes: normaliseRepositoryAttributes(item),
    provenance,
    observationRef,
  };
}

/** A `built_from` edge whose component endpoint is not yet resolved — `repository_ref` only
 *  names a natural key, never a kind, so it needs the same identity-index resolution a
 *  `dependency_observation` endpoint does (review fix: this used to skip resolution entirely and
 *  propose an edge to a component that might not exist at all — see `resolveBuiltFromEdges`). */
export interface PendingBuiltFromEdge {
  readonly componentNaturalKey: string;
  readonly repository: NodeRef;
  readonly provenance: ProvenanceClass;
  readonly observationRef: string;
}

interface Candidates {
  readonly nodes: CandidateNode[];
  readonly pendingBuiltFromEdges: PendingBuiltFromEdge[];
  /** Node kinds a fully-`collected` source produced ≥1 candidate of, this run — `mark_removed`
   *  eligibility ("absence from a source that did not fully answer is not evidence"). */
  readonly collectedKinds: Map<string, Set<DiscoveryNodeKind>>;
}

/** Component/deployment-unit/repository candidates, plus the *unresolved* `built_from` pairs a
 *  `repository_ref` lists (one per `componentNaturalKeys[]` entry, plan "Ingestion rules") —
 *  resolved against the identity index once every candidate node is known
 *  (`resolveBuiltFromEdges`), the same way a `dependency_observation` endpoint is. */
function collectNodeCandidates(
  sources: readonly AcceptedSourceItems[],
  adapterConstants: Readonly<Record<string, AdapterConstants>>,
  tenantId: string,
  runId: string,
): Candidates {
  const nodes: CandidateNode[] = [];
  const pendingBuiltFromEdges: PendingBuiltFromEdge[] = [];
  const collectedKinds = new Map<string, Set<DiscoveryNodeKind>>();

  for (const source of sources) {
    const provenance = adapterConstants[source.sourceKey]?.provenance;
    if (provenance === undefined) continue; // unknown adapter — ingestion already dropped its items
    const kinds = new Set<DiscoveryNodeKind>();
    for (const item of source.items) {
      if (
        item.kind !== 'component_candidate' &&
        item.kind !== 'deployment_unit_candidate' &&
        item.kind !== 'repository_ref'
      ) {
        continue;
      }
      const node = toCandidateNode(item, tenantId, runId, provenance);
      if (node === null) continue;
      nodes.push(node);
      kinds.add(node.ref.nodeKind);
      if (item.kind === 'repository_ref') {
        const observationRef = graphFactId(tenantId, runId, item.kind, item);
        for (const componentNaturalKey of item.componentNaturalKeys) {
          pendingBuiltFromEdges.push({
            componentNaturalKey,
            repository: { nodeKind: 'repository', naturalKey: item.projectRef },
            provenance,
            observationRef,
          });
        }
      }
    }
    // Items contribute to diffing regardless of status (FR-023) — only a fully-`collected`
    // source's kinds license a later `mark_removed`.
    if (kinds.size > 0 && source.finalStatus === 'collected')
      collectedKinds.set(source.sourceKey, kinds);
  }
  return { nodes, pendingBuiltFromEdges, collectedKinds };
}

function diffNodes(
  dedupedNodes: Map<string, CandidateNode>,
  confirmed: readonly ConfirmedNode[],
  push: Push,
): void {
  const confirmedByKey = new Map(confirmed.map((n) => [nodeRefKey(n), n] as const));
  for (const candidate of dedupedNodes.values()) {
    const match = confirmedByKey.get(nodeRefKey(candidate.ref));
    const base = {
      targetNodeId: match?.id ?? null,
      targetEdgeId: null,
      current: match === undefined ? null : { name: match.name, attributes: match.attributes },
      provenance: candidate.provenance,
      strength: provenanceStrength(candidate.provenance),
      // A node candidate carries no observation count/recency (only `dependency_observation`
      // does — 004 reconciliation batch (c)); the flat provenance base is the real value of the
      // full R-15 formula with both the volume and staleness terms at zero, not an invented one.
      confidence: baseConfidence(candidate.provenance),
      observationRef: candidate.observationRef,
    };
    if (match === undefined) {
      push('add_node', {
        ...base,
        proposed: {
          op: 'add_node',
          nodeKind: candidate.ref.nodeKind,
          naturalKey: candidate.ref.naturalKey,
          name: candidate.name,
          attributes: candidate.attributes,
        },
      });
    } else if (
      match.name !== candidate.name ||
      !sameAttributes(match.attributes, candidate.attributes)
    ) {
      push('modify_attributes', {
        ...base,
        proposed: {
          op: 'modify_attributes',
          nodeKind: candidate.ref.nodeKind,
          naturalKey: candidate.ref.naturalKey,
          name: candidate.name,
          attributes: candidate.attributes,
        },
      });
    }
  }
}

/** `dependency_observation` carries real volume/recency; `built_from` does not (`observation` is
 *  `null`) — deriving from a real count when one exists, falling back to the flat provenance base
 *  when it doesn't, is what "use the fields already present, never invent one" (004 reconciliation
 *  batch (c)) means for an edge candidate. Provenance here is always a discovery-adapter class,
 *  never human (`AdapterConstants.provenance`) — never one of the two confirm-only classes the
 *  merge path's type refuses by construction. */
function edgeCandidateConfidence(candidate: CandidateEdge, now: Date): number {
  if (candidate.observation === null) return baseConfidence(candidate.provenance);
  return deriveEdgeConfidence(
    {
      provenance: candidate.provenance as MachineProvenanceClass,
      observationCount: candidate.observation.observationCount,
      lastObservedAt: candidate.observation.lastObservedAt,
    },
    now,
  );
}

function diffEdges(
  dedupedEdges: Map<string, CandidateEdge>,
  confirmed: readonly ConfirmedEdge[],
  now: Date,
  push: Push,
): void {
  const confirmedKeys = new Set(confirmed.map((e) => edgeKey(e.from, e.to, e.edgeType, e.layer)));
  for (const [key, candidate] of dedupedEdges) {
    if (confirmedKeys.has(key)) continue; // matched — no item (merge is T038, Phase 4)
    push('add_edge', {
      targetNodeId: null,
      targetEdgeId: null,
      proposed: {
        op: 'add_edge',
        from: candidate.from,
        to: candidate.to,
        edgeType: candidate.edgeType,
        layer: candidate.layer,
      },
      current: null,
      provenance: candidate.provenance,
      strength: provenanceStrength(candidate.provenance),
      confidence: edgeCandidateConfidence(candidate, now),
      observationRef: candidate.observationRef,
    });
  }
}

/**
 * The draft as a diff (T020, T023, R-07): against confirmed state at `base_version`, every
 * candidate becomes `add_node` / `add_edge` / `modify_attributes` / `mark_removed` / no item —
 * against an empty snapshot every item is an `add_*`, one code path for first run and re-run. The
 * rejection filter (FR-011) is applied in `push`, before an item is ever materialised.
 */
export function buildDraftItems(input: BuildDraftItemsInput): BuildDraftItemsResult {
  const { tenantId, runId, sources, adapterConstants, snapshot, rejectedDigests } = input;
  const now = input.now ?? new Date();

  const {
    nodes: candidateNodes,
    pendingBuiltFromEdges,
    collectedKinds,
  } = collectNodeCandidates(sources, adapterConstants, tenantId, runId);
  const {
    edges: resolvedEdges,
    unresolvedCount,
    unresolvedDependencyKeys,
  } = resolveEdges(sources, pendingBuiltFromEdges, candidateNodes, snapshot.nodes, tenantId, runId);

  const dedupedNodes = dedupeByKey(candidateNodes, (n) => nodeRefKey(n.ref));
  const dedupedEdges = dedupeByKey(resolvedEdges, (e) =>
    edgeKey(e.from, e.to, e.edgeType, e.layer),
  );

  const items: DraftItemCandidate[] = [];
  const absenceEvidence: AbsenceEvidenceCandidate[] = [];
  const countsByOp: Record<DraftItemOp, number> = {
    add_node: 0,
    add_edge: 0,
    modify_attributes: 0,
    mark_removed: 0,
  };
  const push: Push = (op, item) => {
    const digest = proposalDigest(item.proposed);
    if (rejectedDigests.has(digest)) return false;
    items.push({ op, proposalDigest: digest, ...item });
    countsByOp[op] += 1;
    return true;
  };

  diffNodes(dedupedNodes, snapshot.nodes, push);
  diffEdges(dedupedEdges, snapshot.edges, now, push);
  markRemovedNodes(
    snapshot.nodes,
    dedupedNodes,
    collectedKinds,
    adapterConstants,
    tenantId,
    runId,
    push,
    absenceEvidence,
  );
  const finalStatusBySourceKey = new Map(sources.map((s) => [s.sourceKey, s.finalStatus] as const));
  markRemovedEdges(
    snapshot.edges,
    dedupedEdges,
    finalStatusBySourceKey,
    unresolvedDependencyKeys,
    adapterConstants,
    tenantId,
    runId,
    push,
    absenceEvidence,
  );

  return { items, countsByOp, absenceEvidence, unresolvedEdges: unresolvedCount };
}
