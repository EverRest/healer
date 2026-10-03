import type { EdgeType, NodeKind } from './graph-vocabulary.js';

/**
 * The structural separations the constitution requires are EDGES, never columns (FR-002, FR-003,
 * data-model.md "Relationships expressed as edges"): which node kinds each may connect. A single
 * deployable is n components all `deploys`-ing to one unit; a monorepo is n components
 * `built_from` one repository; neither needs a special case because nothing here names a style.
 *
 * The table is exhaustive over `EdgeType` (a new edge type will not compile until it has an entry)
 * and `validateEdge` fails CLOSED on anything outside it. `exposes` is the one underspecified entry
 * (spec lists the type, no endpoint rule): a component or the deployment unit that serves an
 * endpoint may expose it — QUESTIONS.md "004 T036-T052". `calls`, `depends_on` and
 * `serves_feature` are explicitly 'unconstrained' here; their rules belong to other tasks.
 */
interface EndpointRule {
  readonly from: readonly NodeKind[];
  readonly to: readonly NodeKind[];
}

const EDGE_RULES = {
  deploys: { from: ['component'], to: ['deployment_unit'] },
  built_from: { from: ['component'], to: ['repository'] },
  contains: { from: ['component'], to: ['component'] },
  implements: { from: ['endpoint'], to: ['component'] },
  exposes: { from: ['component', 'deployment_unit'], to: ['endpoint'] },
  calls: 'unconstrained',
  depends_on: 'unconstrained',
  serves_feature: 'unconstrained',
} as const satisfies Record<EdgeType, EndpointRule | 'unconstrained'>;

export type StructuralEdgeType = {
  [T in keyof typeof EDGE_RULES]: (typeof EDGE_RULES)[T] extends 'unconstrained' ? never : T;
}[keyof typeof EDGE_RULES];
export const STRUCTURAL_EDGE_TYPES = (Object.keys(EDGE_RULES) as EdgeType[]).filter(
  (t): t is StructuralEdgeType => EDGE_RULES[t] !== 'unconstrained',
);

export type EdgeValidation =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function validateEdge(type: EdgeType, from: NodeKind, to: NodeKind): EdgeValidation {
  if (typeof type !== 'string' || !Object.hasOwn(EDGE_RULES, type))
    return { ok: false, reason: 'unknown edge type' };
  const rule: EndpointRule | 'unconstrained' = EDGE_RULES[type];
  if (rule === 'unconstrained') return { ok: true };
  if (rule.from.includes(from) && rule.to.includes(to)) return { ok: true };
  return {
    ok: false,
    reason: `${type} connects ${rule.from.join('|')} -> ${rule.to.join('|')}, not ${from} -> ${to}`,
  };
}

export interface GraphShapeNode {
  readonly id: string;
  readonly kind: NodeKind;
}

export interface GraphShapeEdge {
  readonly type: EdgeType;
  readonly from: string;
  readonly to: string;
}

export interface EdgeViolation {
  readonly edge: GraphShapeEdge;
  readonly reason: string;
}

/** The reader of the rules above: every edge checked against the kinds of its two endpoints. */
export function findEdgeViolations(
  nodes: readonly GraphShapeNode[],
  edges: readonly GraphShapeEdge[],
): EdgeViolation[] {
  const kindById = new Map(nodes.map((n) => [n.id, n.kind]));
  const violations: EdgeViolation[] = [];
  for (const edge of edges) {
    const from = kindById.get(edge.from);
    const to = kindById.get(edge.to);
    if (from === undefined || to === undefined) {
      violations.push({ edge, reason: 'edge references an unknown node' });
      continue;
    }
    const result = validateEdge(edge.type, from, to);
    if (!result.ok) violations.push({ edge, reason: result.reason });
  }
  return violations;
}
