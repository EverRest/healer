import type { GraphEdgeType } from './closed-vocabularies.js';
import type {
  AcceptedSourceItems,
  CandidateEdge,
  CandidateNode,
  PendingBuiltFromEdge,
} from './diff-builder.js';
import type { ConfirmedNode } from './confirmed-graph-snapshot.js';
import { graphFactId } from './graph-fact-id.js';
import { canonical } from './natural-key-collisions.js';
import type { DiscoveryNodeKind, NodeRef } from './proposed-payload.js';

/**
 * `dependency_observation`/`built_from` endpoint resolution by natural key — split out of
 * `diff-builder.ts` to keep that file under the lint line limit (same reason `mark-removed.ts`
 * is its own module). Only type-only imports flow back to `diff-builder.ts` (erased at compile
 * time), so this module carries no runtime dependency on it despite the two reading each other's
 * shapes.
 */

function buildIdentityIndex(
  candidateNodes: readonly CandidateNode[],
  confirmedNodes: readonly ConfirmedNode[],
): Map<string, Set<DiscoveryNodeKind>> {
  const index = new Map<string, Set<DiscoveryNodeKind>>();
  // Canonical matching (004 reconciliation batch (f)): same fold as node-key.ts.
  const add = (naturalKey: string, nodeKind: DiscoveryNodeKind) => {
    const key = canonical(naturalKey);
    index.set(key, (index.get(key) ?? new Set<DiscoveryNodeKind>()).add(nodeKind));
  };
  for (const n of candidateNodes) add(n.ref.naturalKey, n.ref.nodeKind);
  for (const n of confirmedNodes) add(n.naturalKey, n.nodeKind);
  return index;
}

function resolveRef(
  naturalKey: string,
  index: Map<string, Set<DiscoveryNodeKind>>,
): NodeRef | null {
  const kinds = index.get(canonical(naturalKey));
  return kinds === undefined || kinds.size !== 1 ? null : { nodeKind: [...kinds][0]!, naturalKey };
}

/** `${fromNaturalKey}>${toNaturalKey}|${edgeType}|${layer}` — the natural-key-only edge key used
 *  when an endpoint never resolved to an id, so there is no `NodeRef` (with a kind) to build
 *  `edgeKey()`'s usual key from. */
export function naturalEdgeKey(
  fromNaturalKey: string,
  toNaturalKey: string,
  edgeType: string,
  layer: string,
): string {
  return `${canonical(fromNaturalKey)}>${canonical(toNaturalKey)}|${edgeType}|${layer}`;
}

export interface EdgeResolutionResult {
  readonly edges: CandidateEdge[];
  /** Review fix (#11): dropped with no count or log before — a `dependency_observation` or
   *  `built_from` pair whose endpoint resolves to no candidate/confirmed node, or to more than
   *  one, was silently discarded. Counted here so the caller can log it (this module stays pure). */
  readonly unresolvedCount: number;
  /** Natural-key edge keys for every unresolved `dependency_observation` this run (review fix
   *  #11, #5's sibling concern) — `markRemovedEdges` must not treat "could not resolve" the same
   *  as "looked and did not see": an ambiguous or missing identity is not a full answer either
   *  (plan: "absence from a source that did not fully answer is not evidence"). */
  readonly unresolvedDependencyKeys: ReadonlySet<string>;
}

/** `dependency_observation` and `built_from` candidate edges — endpoints resolved by natural key
 *  across candidates and confirmed nodes together, in one pass, so a `built_from` endpoint gets
 *  exactly the same resolution a `dependency_observation` endpoint does (review fix #5: it
 *  previously proposed an edge to an unresolved component unconditionally). Zero or more than one
 *  match is "not proposed" — its evidence is still written by the ingestion layer, independent of
 *  this, and it is counted above rather than silently dropped. */
export function resolveEdges(
  sources: readonly AcceptedSourceItems[],
  pendingBuiltFromEdges: readonly PendingBuiltFromEdge[],
  candidateNodes: readonly CandidateNode[],
  confirmedNodes: readonly ConfirmedNode[],
  tenantId: string,
  runId: string,
): EdgeResolutionResult {
  const identityIndex = buildIdentityIndex(candidateNodes, confirmedNodes);
  const edges: CandidateEdge[] = [];
  let unresolvedCount = 0;
  const unresolvedDependencyKeys = new Set<string>();

  for (const source of sources) {
    for (const item of source.items) {
      if (item.kind !== 'dependency_observation') continue;
      const from = resolveRef(item.fromNaturalKey, identityIndex);
      const to = resolveRef(item.toNaturalKey, identityIndex);
      if (from === null || to === null) {
        unresolvedCount += 1;
        unresolvedDependencyKeys.add(
          naturalEdgeKey(item.fromNaturalKey, item.toNaturalKey, item.edgeType, item.layer),
        );
        continue;
      }
      edges.push({
        from,
        to,
        edgeType: item.edgeType as GraphEdgeType,
        layer: item.layer,
        provenance: item.provenance,
        observationRef: graphFactId(tenantId, runId, item.kind, item),
        observation: {
          observationCount: item.observationCount,
          lastObservedAt: new Date(item.lastObservedAt),
        },
      });
    }
  }

  for (const pending of pendingBuiltFromEdges) {
    // A `built_from` edge is always component -> repository (data-model.md); a natural key that
    // resolves to some *other* kind is exactly as unresolved as one that resolves to nothing.
    const from = resolveRef(pending.componentNaturalKey, identityIndex);
    if (from === null || from.nodeKind !== 'component') {
      unresolvedCount += 1;
      continue;
    }
    edges.push({
      from,
      to: pending.repository,
      edgeType: 'built_from',
      layer: 'code',
      provenance: pending.provenance,
      observationRef: pending.observationRef,
      // A `built_from` relation carries no `dependency_observation`-shaped observation count —
      // `repository_ref` names no volume or recency (004 reconciliation batch (c)). `null` here
      // means "use the flat provenance base", not an invented count.
      observation: null,
    });
  }

  return { edges, unresolvedCount, unresolvedDependencyKeys };
}
