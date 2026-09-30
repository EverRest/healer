import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ReadEnvelopeInvariantError,
  toReadEnvelope,
  type ReadEnvelope,
} from './read-envelope.js';

interface Item {
  readonly id: string;
}

describe('toReadEnvelope (004 T013, R-13)', () => {
  it('carries graphVersion, coverage and items together', () => {
    const items: readonly Item[] = [{ id: 'n1' }];
    const coverage = { nodesConfirmed: 2, nodesTotal: 5, edgesConfirmed: 1, edgesTotal: 3 };
    const envelope = toReadEnvelope(7, true, coverage, items);
    expect(envelope).toEqual({
      graphVersion: 7,
      confirmationState: 'partially_confirmed',
      coverage,
      items,
    });
  });

  it('accepts an empty graph, labelled unconfirmed rather than mistaken for "no dependency"', () => {
    const envelope = toReadEnvelope(
      0,
      false,
      { nodesConfirmed: 0, nodesTotal: 0, edgesConfirmed: 0, edgesTotal: 0 },
      [] as readonly Item[],
    );
    expect(envelope.confirmationState).toBe('never_discovered');
    expect(envelope.items).toEqual([]);
  });

  it('rejects coverage claiming more confirmed nodes than exist', () => {
    expect(() =>
      toReadEnvelope(1, true, { nodesConfirmed: 6, nodesTotal: 5, edgesConfirmed: 0, edgesTotal: 0 }, []),
    ).toThrow(ReadEnvelopeInvariantError);
  });

  it('rejects coverage claiming more confirmed edges than exist', () => {
    expect(() =>
      toReadEnvelope(1, true, { nodesConfirmed: 0, nodesTotal: 0, edgesConfirmed: 4, edgesTotal: 3 }, []),
    ).toThrow(ReadEnvelopeInvariantError);
  });

  describe('confirmationState is derived from coverage, never a free-standing input (review fix)', () => {
    it('is never_discovered when discovery has never run, regardless of coverage', () => {
      const envelope = toReadEnvelope(
        0,
        false,
        { nodesConfirmed: 3, nodesTotal: 3, edgesConfirmed: 3, edgesTotal: 3 },
        [],
      );
      // Even a coverage that looks "fully confirmed" cannot promote a never-discovered graph —
      // `discovered` is the one input that decides this branch.
      expect(envelope.confirmationState).toBe('never_discovered');
    });

    it('is unconfirmed once discovered but nothing has been confirmed yet', () => {
      const envelope = toReadEnvelope(
        1,
        true,
        { nodesConfirmed: 0, nodesTotal: 5, edgesConfirmed: 0, edgesTotal: 2 },
        [],
      );
      expect(envelope.confirmationState).toBe('unconfirmed');
    });

    it('is unconfirmed when discovered but the graph has no elements at all', () => {
      const envelope = toReadEnvelope(
        1,
        true,
        { nodesConfirmed: 0, nodesTotal: 0, edgesConfirmed: 0, edgesTotal: 0 },
        [],
      );
      expect(envelope.confirmationState).toBe('unconfirmed');
    });

    it('is partially_confirmed when some but not all elements are confirmed', () => {
      const envelope = toReadEnvelope(
        1,
        true,
        { nodesConfirmed: 2, nodesTotal: 5, edgesConfirmed: 3, edgesTotal: 3 },
        [],
      );
      expect(envelope.confirmationState).toBe('partially_confirmed');
    });

    it('is confirmed only once both nodes and edges are fully confirmed', () => {
      const envelope = toReadEnvelope(
        1,
        true,
        { nodesConfirmed: 5, nodesTotal: 5, edgesConfirmed: 3, edgesTotal: 3 },
        [],
      );
      expect(envelope.confirmationState).toBe('confirmed');
    });

    it('cannot be constructed as "confirmed" while nodesConfirmed < nodesTotal (the bug a free parameter allowed)', () => {
      // There is no `confirmationState` parameter left to pass 'confirmed' through — the only way
      // to reach it is coverage that actually is fully confirmed, proven by the case above.
      const envelope = toReadEnvelope(
        1,
        true,
        { nodesConfirmed: 4, nodesTotal: 5, edgesConfirmed: 3, edgesTotal: 3 },
        [],
      );
      expect(envelope.confirmationState).not.toBe('confirmed');
    });
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

  // @ts-expect-error confirmationState is derived, not an accepted argument, since 004 T013's review fix
  toReadEnvelope(1, 'confirmed', { nodesConfirmed: 1, nodesTotal: 1, edgesConfirmed: 1, edgesTotal: 1 }, []);
}
void typeProofNeverCalled;
