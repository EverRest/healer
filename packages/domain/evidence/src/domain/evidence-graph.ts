import type { TenantScoped } from '@healer/shared';
import type {
  ConclusionType,
  Evidence,
  EvidenceLink,
  EvidenceRelation,
  EvidenceType,
  RefState,
} from './types.js';

export type EvidenceGraphNode =
  | {
      readonly kind: 'evidence';
      readonly id: string;
      readonly type: EvidenceType;
      readonly sourceLabel: string;
      readonly refState: RefState;
      readonly observedAt: Date;
    }
  | { readonly kind: 'conclusion'; readonly id: string; readonly conclusionType: ConclusionType };

export interface EvidenceGraphEdge {
  readonly evidenceId: string;
  readonly conclusionId: string;
  readonly relation: EvidenceRelation;
  readonly assertedByStep: string;
  readonly assertedAt: Date;
}

export interface EvidenceGraph {
  readonly nodes: readonly EvidenceGraphNode[];
  readonly edges: readonly EvidenceGraphEdge[];
}

export interface EvidenceGraphRepository {
  forIssue(where: TenantScoped<{ readonly issueId: string }>): Promise<EvidenceGraph>;
}

const byKey =
  <T>(key: (value: T) => string) =>
  (a: T, b: T) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;

/**
 * The evidence graph (001 T047, FR-013): the same evidence and link rows the timeline reads,
 * arranged as nodes and edges. Pure and total-ordered — evidence by `(observedAt, id)`, conclusions
 * by `id`, edges by their unique `(evidenceId, conclusionId, relation)` — so the same records
 * always render the same bytes (SC-005). Uncited and detached evidence stay in as nodes: a graph
 * of only what conclusions used would hide what they left out. Nodes carry structure only, never
 * an excerpt or payload.
 */
export function buildEvidenceGraph(
  evidence: readonly Evidence[],
  links: readonly EvidenceLink[],
): EvidenceGraph {
  const evidenceNodes = [...evidence]
    .sort(byKey((e) => `${e.observedAt.toISOString()}|${e.id}`))
    .map((e): EvidenceGraphNode => ({
      kind: 'evidence',
      id: e.id,
      type: e.type,
      sourceLabel: e.sourceLabel,
      refState: e.refState,
      observedAt: e.observedAt,
    }));
  // Nothing in the database stops one `conclusionId` carrying two `conclusionType`s; the smallest
  // wins so the node never depends on the order rows arrived in.
  const conclusionTypes = new Map<string, ConclusionType>();
  for (const l of links) {
    const known = conclusionTypes.get(l.conclusionId);
    if (known === undefined || l.conclusionType < known) {
      conclusionTypes.set(l.conclusionId, l.conclusionType);
    }
  }
  const conclusionNodes = [...conclusionTypes]
    .map(([id, conclusionType]): EvidenceGraphNode => ({ kind: 'conclusion', id, conclusionType }))
    .sort(byKey((n) => n.id));
  const edges = links
    .map((l) => ({
      evidenceId: l.evidenceId,
      conclusionId: l.conclusionId,
      relation: l.relation,
      assertedByStep: l.assertedByStep,
      assertedAt: l.assertedAt,
    }))
    .sort(byKey((e) => `${e.evidenceId}|${e.conclusionId}|${e.relation}`));
  return { nodes: [...evidenceNodes, ...conclusionNodes], edges };
}
