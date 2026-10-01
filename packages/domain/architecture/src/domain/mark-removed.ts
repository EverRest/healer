import type {
  AbsenceEvidenceCandidate,
  CandidateEdge,
  CandidateNode,
  Push,
} from './diff-builder.js';
import type { AdapterConstants, DiscoverySourceStatus } from './discovery-batch.js';
import { provenanceBaseConfidence } from './confidence.js';
import type { ConfirmedEdge, ConfirmedNode } from './confirmed-graph-snapshot.js';
import { graphFactId } from './graph-fact-id.js';
import { edgeKey, nodeRefKey } from './node-key.js';
import { provenanceStrength } from './provenance-strength.js';
import type { DiscoveryNodeKind } from './proposed-payload.js';

/**
 * `mark_removed` (plan "The draft as a diff"): a confirmed element some fully-`collected` source
 * was positioned to re-observe this run, and did not — "absence from a source that did not fully
 * answer is not evidence". Split out of `diff-builder.ts` to keep that file under the lint line
 * limit; both halves of one diff algorithm, read together.
 */
export function markRemovedNodes(
  confirmed: readonly ConfirmedNode[],
  dedupedNodes: Map<string, CandidateNode>,
  collectedKinds: Map<string, Set<DiscoveryNodeKind>>,
  adapterConstants: Readonly<Record<string, AdapterConstants>>,
  tenantId: string,
  runId: string,
  push: Push,
  absenceEvidence: AbsenceEvidenceCandidate[],
): void {
  for (const node of confirmed) {
    if (dedupedNodes.has(nodeRefKey(node))) continue;
    const triggerSourceKey = [...collectedKinds.entries()]
      .filter(([, kinds]) => kinds.has(node.nodeKind))
      .map(([sourceKey]) => sourceKey)
      .sort()[0];
    if (triggerSourceKey === undefined) continue;
    const provenance = adapterConstants[triggerSourceKey]!.provenance;
    const absenceId = graphFactId(tenantId, runId, 'absence:node', node);
    absenceEvidence.push({
      id: absenceId,
      sourceSystem: triggerSourceKey,
      sourceLabel: `${triggerSourceKey} discovery run ${runId}: no longer observed`,
      payload: {
        kind: 'absence',
        targetKind: 'node',
        nodeKind: node.nodeKind,
        naturalKey: node.naturalKey,
      },
    });
    push('mark_removed', {
      targetNodeId: node.id,
      targetEdgeId: null,
      proposed: {
        op: 'mark_removed',
        target: { kind: 'node', nodeKind: node.nodeKind, naturalKey: node.naturalKey },
      },
      current: { name: node.name, attributes: node.attributes },
      provenance,
      strength: provenanceStrength(provenance),
      confidence: provenanceBaseConfidence(provenance),
      observationRef: absenceId,
    });
  }
}

export function markRemovedEdges(
  confirmed: readonly ConfirmedEdge[],
  dedupedEdges: Map<string, CandidateEdge>,
  finalStatusBySourceKey: Map<string, DiscoverySourceStatus>,
  adapterConstants: Readonly<Record<string, AdapterConstants>>,
  tenantId: string,
  runId: string,
  push: Push,
  absenceEvidence: AbsenceEvidenceCandidate[],
): void {
  for (const edge of confirmed) {
    const key = edgeKey(edge.from, edge.to, edge.edgeType, edge.layer);
    if (dedupedEdges.has(key)) continue;
    if (edge.contributingAdapterKeys.length === 0) continue;
    const allCollected = edge.contributingAdapterKeys.every(
      (k) => finalStatusBySourceKey.get(k) === 'collected',
    );
    if (!allCollected) continue;
    const triggerSourceKey = [...edge.contributingAdapterKeys].sort()[0]!;
    const provenance = adapterConstants[triggerSourceKey]!.provenance;
    const absenceId = graphFactId(tenantId, runId, 'absence:edge', edge);
    absenceEvidence.push({
      id: absenceId,
      sourceSystem: triggerSourceKey,
      sourceLabel: `${triggerSourceKey} discovery run ${runId}: no longer observed`,
      payload: {
        kind: 'absence',
        targetKind: 'edge',
        from: edge.from,
        to: edge.to,
        edgeType: edge.edgeType,
        layer: edge.layer,
      },
    });
    push('mark_removed', {
      targetNodeId: null,
      targetEdgeId: edge.id,
      proposed: {
        op: 'mark_removed',
        target: {
          kind: 'edge',
          from: edge.from,
          to: edge.to,
          edgeType: edge.edgeType,
          layer: edge.layer,
        },
      },
      current: { from: edge.from, to: edge.to, edgeType: edge.edgeType, layer: edge.layer },
      provenance,
      strength: provenanceStrength(provenance),
      confidence: provenanceBaseConfidence(provenance),
      observationRef: absenceId,
    });
  }
}
