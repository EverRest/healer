/**
 * The read envelope every graph read returns, HTTP or in-process (R-13, quickstart 29,
 * graph-contract.md "Read envelope"). No surface returns a bare array: a consumer that reads the
 * response at all can tell "no dependency" from "the graph does not know" (FR-016), and emptiness
 * is never mistakable for safety.
 *
 * The envelope's four required fields — none optional — are what makes a bare `T[]` fail to
 * satisfy `ReadEnvelope<T>` structurally: an array has no `graphVersion`, `confirmationState` or
 * `coverage` property, so TypeScript rejects it at the assignment, not at a runtime check
 * (docs/patterns.md — make the unsafe state unrepresentable).
 */
export type ConfirmationState =
  | 'never_discovered'
  | 'unconfirmed'
  | 'partially_confirmed'
  | 'confirmed';

export interface Coverage {
  readonly nodesConfirmed: number;
  readonly nodesTotal: number;
  readonly edgesConfirmed: number;
  readonly edgesTotal: number;
}

export interface ReadEnvelope<T> {
  readonly graphVersion: number;
  readonly confirmationState: ConfirmationState;
  readonly coverage: Coverage;
  readonly items: T;
}

export class ReadEnvelopeInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReadEnvelopeInvariantError';
  }
}

/**
 * The only constructor. A query layer builds `items` however it likes; this is what stops it from
 * handing that value to a caller without also stating the version, confirmation state and
 * coverage it was read against — the omission that a bare-array return would otherwise let
 * through invisibly.
 */
export function toReadEnvelope<T>(
  graphVersion: number,
  confirmationState: ConfirmationState,
  coverage: Coverage,
  items: T,
): ReadEnvelope<T> {
  if (coverage.nodesConfirmed > coverage.nodesTotal) {
    throw new ReadEnvelopeInvariantError('coverage.nodesConfirmed cannot exceed coverage.nodesTotal');
  }
  if (coverage.edgesConfirmed > coverage.edgesTotal) {
    throw new ReadEnvelopeInvariantError('coverage.edgesConfirmed cannot exceed coverage.edgesTotal');
  }
  return { graphVersion, confirmationState, coverage, items };
}
