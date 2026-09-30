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
 * `confirmationState` is derived from `coverage`, never accepted as its own argument — a free
 * parameter could otherwise disagree with the counts sitting right next to it (`'confirmed'` with
 * `nodesConfirmed < nodesTotal`), and an exported interface is structurally satisfied by any
 * matching object literal, so nothing but the constructor itself could have caught that. `total`
 * confirmed against `total` overall is safe to compare as one sum only because the two range
 * checks above already hold per field — a sum that reaches the total therefore means *both*
 * `nodesConfirmed === nodesTotal` and `edgesConfirmed === edgesTotal`, not one masking the other.
 */
function deriveConfirmationState(discovered: boolean, coverage: Coverage): ConfirmationState {
  if (!discovered) return 'never_discovered';
  const confirmed = coverage.nodesConfirmed + coverage.edgesConfirmed;
  const total = coverage.nodesTotal + coverage.edgesTotal;
  if (total === 0 || confirmed === 0) return 'unconfirmed';
  return confirmed === total ? 'confirmed' : 'partially_confirmed';
}

/**
 * The only constructor. A query layer builds `items` however it likes; this is what stops it from
 * handing that value to a caller without also stating the version, confirmation state and
 * coverage it was read against — the omission that a bare-array return would otherwise let
 * through invisibly. `discovered` is the one fact `coverage` cannot supply on its own — a tenant
 * discovery has never run for is indistinguishable, by counts alone, from one whose graph is
 * genuinely empty (spec edge case: "a consumer queries the graph before any discovery has run").
 */
export function toReadEnvelope<T>(
  graphVersion: number,
  discovered: boolean,
  coverage: Coverage,
  items: T,
): ReadEnvelope<T> {
  if (coverage.nodesConfirmed > coverage.nodesTotal) {
    throw new ReadEnvelopeInvariantError('coverage.nodesConfirmed cannot exceed coverage.nodesTotal');
  }
  if (coverage.edgesConfirmed > coverage.edgesTotal) {
    throw new ReadEnvelopeInvariantError('coverage.edgesConfirmed cannot exceed coverage.edgesTotal');
  }
  return { graphVersion, confirmationState: deriveConfirmationState(discovered, coverage), coverage, items };
}
