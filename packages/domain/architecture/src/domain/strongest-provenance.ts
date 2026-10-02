export interface RankedProvenance {
  readonly strength: number;
  readonly recordedAt: Date;
  readonly id: string;
}

/**
 * The one order that decides which `edge_provenance` row represents an edge: strongest first, ties
 * by earliest recorded, then by id so two rows written in the same transaction (same `recorded_at`)
 * still have exactly one winner. The merge path's SQL (`ORDER BY strength DESC, recorded_at ASC,
 * id ASC`) and `check:edge-strength-max` say the same thing in SQL.
 */
export function compareStrongestFirst(a: RankedProvenance, b: RankedProvenance): number {
  return (
    b.strength - a.strength ||
    a.recordedAt.getTime() - b.recordedAt.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}
