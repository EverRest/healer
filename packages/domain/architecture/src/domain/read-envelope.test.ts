import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ReadEnvelopeInvariantError,
  toReadEnvelope,
  type ReadEnvelope,
} from './read-envelope.js';

interface Item {
  readonly id: string;
}

const COVERAGE = { nodesConfirmed: 2, nodesTotal: 5, edgesConfirmed: 1, edgesTotal: 3 };

describe('toReadEnvelope (004 T013, R-13)', () => {
  it('carries graphVersion, confirmationState, coverage and items together', () => {
    const items: readonly Item[] = [{ id: 'n1' }];
    const envelope = toReadEnvelope(7, 'partially_confirmed', COVERAGE, items);
    expect(envelope).toEqual({
      graphVersion: 7,
      confirmationState: 'partially_confirmed',
      coverage: COVERAGE,
      items,
    });
  });

  it('accepts an empty graph, labelled unconfirmed rather than mistaken for "no dependency"', () => {
    const envelope = toReadEnvelope(
      0,
      'never_discovered',
      { nodesConfirmed: 0, nodesTotal: 0, edgesConfirmed: 0, edgesTotal: 0 },
      [] as readonly Item[],
    );
    expect(envelope.confirmationState).toBe('never_discovered');
    expect(envelope.items).toEqual([]);
  });

  it('rejects coverage claiming more confirmed nodes than exist', () => {
    expect(() =>
      toReadEnvelope(
        1,
        'confirmed',
        { nodesConfirmed: 6, nodesTotal: 5, edgesConfirmed: 0, edgesTotal: 0 },
        [],
      ),
    ).toThrow(ReadEnvelopeInvariantError);
  });

  it('rejects coverage claiming more confirmed edges than exist', () => {
    expect(() =>
      toReadEnvelope(
        1,
        'confirmed',
        { nodesConfirmed: 0, nodesTotal: 0, edgesConfirmed: 4, edgesTotal: 3 },
        [],
      ),
    ).toThrow(ReadEnvelopeInvariantError);
  });
});

/**
 * The type-level half of R-13: a bare array cannot stand in for the envelope. Checked by
 * `tsc --build`, never invoked.
 */
function typeProofNeverCalled(): void {
  function acceptsEnvelope(_envelope: ReadEnvelope<readonly Item[]>): void {}
  const bareArray: readonly Item[] = [{ id: 'n1' }];
  // @ts-expect-error a bare array has no graphVersion/confirmationState/coverage — it is not a ReadEnvelope
  acceptsEnvelope(bareArray);

  expectTypeOf<ReadEnvelope<readonly Item[]>>().not.toEqualTypeOf<readonly Item[]>();
}
void typeProofNeverCalled;
