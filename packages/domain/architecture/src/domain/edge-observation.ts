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
  /**
   * The reference instant confidence is evaluated against: the end of the observation window the
   * run read (R-15 — "against the observation window, not today"). Part of the input so a retried
   * job stores the same confidence for the same observation; there is no wall-clock default.
   */
  readonly observedUntil: Date;
  /** Graph version a newly created edge becomes valid from (the run's base version). */
  readonly baseVersion: number;
}

/** How far past the window end an observation timestamp may sit before it is a bad clock. */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;

/** The observation's own numbers or instants cannot be right; nothing is stored. */
export class InvalidEdgeObservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEdgeObservationError';
  }
}

/**
 * The same `observation_ref` reached an edge again with a different provenance, adapter or run:
 * a replay would be identical, so this is two different facts claiming one evidence id. Silently
 * keeping the first would drop the second.
 */
export class ObservationReplayMismatchError extends Error {
  constructor(readonly observationRef: string) {
    super(
      `observation ${observationRef} was already recorded for this edge with different content`,
    );
    this.name = 'ObservationReplayMismatchError';
  }
}

export function assertValidObservation(o: {
  readonly observationCount: number;
  readonly lastObservedAt: Date;
  readonly observedUntil: Date;
}): void {
  if (!Number.isSafeInteger(o.observationCount) || o.observationCount < 1) {
    throw new InvalidEdgeObservationError('observationCount must be a safe integer >= 1');
  }
  for (const [name, value] of [
    ['lastObservedAt', o.lastObservedAt],
    ['observedUntil', o.observedUntil],
  ] as const) {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new InvalidEdgeObservationError(`${name} must be a valid Date`);
    }
  }
  if (o.lastObservedAt.getTime() > o.observedUntil.getTime() + MAX_CLOCK_SKEW_MS) {
    throw new InvalidEdgeObservationError(
      'lastObservedAt is after the end of the observation window',
    );
  }
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
 * Throws `GraphConcurrencyError` when the database reports a serialization failure or deadlock,
 * `InvalidEdgeObservationError` for impossible numbers or instants, and
 * `ObservationReplayMismatchError` when a replayed `observationRef` differs from what was stored.
 */
export interface EdgeProvenanceRepository {
  mergeObservation(observation: TenantScoped<EdgeObservation>): Promise<MergedEdge>;
}
