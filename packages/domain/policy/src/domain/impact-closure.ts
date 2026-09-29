// `ImpactClosure` belongs to 004 (architecture graph), which has not landed in this repository
// yet (docs/domain/glossary.md: "traverses every edge, has no confidence parameter, monotone in
// the edge set"). Per the batch-3 brief, this shape is defined locally, scoped to exactly what
// the closed predicate vocabulary needs (`containsNoneOf` / `subsetOf` / `sizeAtMost` /
// `maxDepthAtMost`, contracts/evaluation.md) — not a general graph-traversal type. When 004 lands
// its own `ImpactClosure`, this local shape should be replaced by an import from that package
// rather than kept as a second definition (C-16/C-19: one authority for a closed vocabulary).
//
// `memberIds` is the closed set of node identifiers (e.g. component ids) the traversal reached —
// antitone-only operators read from it (`containsNoneOf`, `subsetOf`, `sizeAtMost` = its size).
// `maxDepth` is the deepest edge distance the traversal reached from the proposal's target.
export interface ImpactClosure {
  readonly memberIds: readonly string[];
  readonly maxDepth: number;
}
