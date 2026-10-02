import type { TenantScoped } from '@healer/shared';
import type { GraphLayer, ProvenanceClass } from './provenance.js';

/** The two human classes (FR-005). Humans author `graph_node`/`graph_edge` directly. */
export type HumanProvenanceClass = Extract<ProvenanceClass, 'human_authored' | 'human_confirmed'>;

/**
 * What the merge path accepts. `edge_provenance` carries no actor reference (data-model.md), so a
 * human class would be a row with neither observation nor actor — the type refuses to express it
 * rather than a check refusing it later (QUESTIONS.md "004 T036-T052 — judgment calls").
 */
export type MachineProvenanceClass = Exclude<ProvenanceClass, HumanProvenanceClass>;

/** An already-formed, already-resolved observation of one edge (nodes are matched upstream). */
export interface EdgeObservation {
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly edgeType: string;
  readonly layer: GraphLayer;
  readonly provenance: MachineProvenanceClass;
  /** `evidence.id` of the step's `graph_fact` record — also the replay key for this edge. */
  readonly observationRef: string;
  readonly adapterKey: string;
  readonly adapterVersion: string;
  readonly discoveryRunId?: string;
  /** Volume: how many times the source saw it. 1 is an observation, not a fact. */
  readonly observationCount: number;
  readonly lastObservedAt: Date;
  /** Graph version a newly created edge becomes valid from (the run's base version). */
  readonly baseVersion: number;
}

export interface MergedEdge {
  readonly edgeId: string;
  /** False when this edge row already existed and only gained a provenance row. */
  readonly created: boolean;
  /** False when `observationRef` was already recorded for this edge: a replay changes nothing. */
  readonly recorded: boolean;
}

/**
 * Merge one observation into the graph (FR-008, R-03): one `graph_edge` per logical edge, one
 * `edge_provenance` row per observation, the edge's strength/confidence the maximum over them.
 * Throws `GraphConcurrencyError` when the database reports a serialization failure or deadlock.
 */
export interface EdgeProvenanceRepository {
  mergeObservation(observation: TenantScoped<EdgeObservation>, now?: Date): Promise<MergedEdge>;
}
