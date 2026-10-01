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
import { provenanceBaseConfidence } from './confidence.js';
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
}

export type Push = (
  op: DraftItemOp,
  item: Omit<DraftItemCandidate, 'op' | 'proposalDigest'>,
) => void;

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

interface Candidates {
  readonly nodes: CandidateNode[];
  readonly edges: CandidateEdge[];
  /** Node kinds a fully-`collected` source produced ≥1 candidate of, this run — `mark_removed`
   *  eligibility ("absence from a source that did not fully answer is not evidence"). */
  readonly collectedKinds: Map<string, Set<DiscoveryNodeKind>>;
}

/** Component/deployment-unit/repository candidates, plus the `built_from` edges a `repository_ref`
 *  carries (one per `componentNaturalKeys[]` entry, plan "Ingestion rules"). */
function collectNodeCandidates(
  sources: readonly AcceptedSourceItems[],
  adapterConstants: Readonly<Record<string, AdapterConstants>>,
  tenantId: string,
  runId: string,
): Candidates {
  const nodes: CandidateNode[] = [];
  const edges: CandidateEdge[] = [];
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
          edges.push({
            from: { nodeKind: 'component', naturalKey: componentNaturalKey },
            to: { nodeKind: 'repository', naturalKey: item.projectRef },
            edgeType: 'built_from',
            layer: 'code',
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
  return { nodes, edges, collectedKinds };
}

function buildIdentityIndex(
  candidateNodes: readonly CandidateNode[],
  confirmedNodes: readonly ConfirmedNode[],
): Map<string, Set<DiscoveryNodeKind>> {
  const index = new Map<string, Set<DiscoveryNodeKind>>();
  const add = (naturalKey: string, nodeKind: DiscoveryNodeKind) =>
    index.set(naturalKey, (index.get(naturalKey) ?? new Set<DiscoveryNodeKind>()).add(nodeKind));
  for (const n of candidateNodes) add(n.ref.naturalKey, n.ref.nodeKind);
  for (const n of confirmedNodes) add(n.naturalKey, n.nodeKind);
  return index;
}

function resolveRef(
  naturalKey: string,
  index: Map<string, Set<DiscoveryNodeKind>>,
): NodeRef | null {
  const kinds = index.get(naturalKey);
  return kinds === undefined || kinds.size !== 1 ? null : { nodeKind: [...kinds][0]!, naturalKey };
}

/** `dependency_observation` candidate edges — endpoints resolved by natural key across candidates
 *  and confirmed nodes together; zero or more than one match is "not proposed" (its evidence is
 *  still written by the ingestion layer, independent of this). */
function collectDependencyEdges(
  sources: readonly AcceptedSourceItems[],
  candidateNodes: readonly CandidateNode[],
  confirmedNodes: readonly ConfirmedNode[],
  tenantId: string,
  runId: string,
): CandidateEdge[] {
  const identityIndex = buildIdentityIndex(candidateNodes, confirmedNodes);
  const edges: CandidateEdge[] = [];
  for (const source of sources) {
    for (const item of source.items) {
      if (item.kind !== 'dependency_observation') continue;
      const from = resolveRef(item.fromNaturalKey, identityIndex);
      const to = resolveRef(item.toNaturalKey, identityIndex);
      if (from === null || to === null) continue;
      edges.push({
        from,
        to,
        edgeType: item.edgeType as GraphEdgeType,
        layer: item.layer,
        provenance: item.provenance,
        observationRef: graphFactId(tenantId, runId, item.kind, item),
      });
    }
  }
  return edges;
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
      confidence: provenanceBaseConfidence(candidate.provenance),
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

function diffEdges(
  dedupedEdges: Map<string, CandidateEdge>,
  confirmed: readonly ConfirmedEdge[],
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
      confidence: provenanceBaseConfidence(candidate.provenance),
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

  const {
    nodes: candidateNodes,
    edges: builtFromEdges,
    collectedKinds,
  } = collectNodeCandidates(sources, adapterConstants, tenantId, runId);
  const dependencyEdges = collectDependencyEdges(
    sources,
    candidateNodes,
    snapshot.nodes,
    tenantId,
    runId,
  );

  const dedupedNodes = dedupeByKey(candidateNodes, (n) => nodeRefKey(n.ref));
  const dedupedEdges = dedupeByKey([...builtFromEdges, ...dependencyEdges], (e) =>
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
    if (rejectedDigests.has(digest)) return;
    items.push({ op, proposalDigest: digest, ...item });
    countsByOp[op] += 1;
  };

  diffNodes(dedupedNodes, snapshot.nodes, push);
  diffEdges(dedupedEdges, snapshot.edges, push);
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
    adapterConstants,
    tenantId,
    runId,
    push,
    absenceEvidence,
  );

  return { items, countsByOp, absenceEvidence };
}
