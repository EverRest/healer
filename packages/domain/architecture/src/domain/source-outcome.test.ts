import { describe, expect, it } from 'vitest';
import { deriveProvisionalSourceOutcome, downgradeForRejectedItems } from './source-outcome.js';

/** T019: 003's six statuses and nine reason codes, no local set (plan "Source outcomes"). */
describe('deriveProvisionalSourceOutcome (T019)', () => {
  it('not requested -> not_attempted, no reason ("there is no skipped")', () => {
    expect(deriveProvisionalSourceOutcome({ kind: 'not_requested' })).toEqual({
      status: 'not_attempted',
      reasonCode: null,
    });
  });

  it('adapter threw -> unavailable/source_unreachable (quickstart 41)', () => {
    expect(deriveProvisionalSourceOutcome({ kind: 'threw' })).toEqual({
      status: 'unavailable',
      reasonCode: 'source_unreachable',
    });
  });

  it('per-source timeout -> timed_out/timeout', () => {
    expect(deriveProvisionalSourceOutcome({ kind: 'timed_out' })).toEqual({
      status: 'timed_out',
      reasonCode: 'timeout',
    });
  });

  it('completed with items, no gaps, not truncated -> collected, no reason', () => {
    const outcome = deriveProvisionalSourceOutcome({
      kind: 'completed',
      items: [{ kind: 'repository_ref' } as never],
      gaps: [],
      truncated: false,
      anyEgressRejected: false,
    });
    expect(outcome).toEqual({ status: 'collected', reasonCode: null });
  });

  it('completed with nothing at all -> collected/empty_result', () => {
    const outcome = deriveProvisionalSourceOutcome({
      kind: 'completed',
      items: [],
      gaps: [],
      truncated: false,
      anyEgressRejected: false,
    });
    expect(outcome).toEqual({ status: 'collected', reasonCode: 'empty_result' });
  });

  it('completed with a region gap -> partial, no reason code (gap names it, quickstart 42)', () => {
    const outcome = deriveProvisionalSourceOutcome({
      kind: 'completed',
      items: [{ kind: 'repository_ref' } as never],
      gaps: [
        { kind: 'collection_gap', what: 'vendor/', why: 'unparsable', withheldByRedaction: false },
      ],
      truncated: false,
      anyEgressRejected: false,
    });
    expect(outcome).toEqual({ status: 'partial', reasonCode: null });
  });

  it('item cap truncated the results -> partial, no reason code (the gap says truncated)', () => {
    const outcome = deriveProvisionalSourceOutcome({
      kind: 'completed',
      items: [{ kind: 'repository_ref' } as never],
      gaps: [],
      truncated: true,
      anyEgressRejected: false,
    });
    expect(outcome).toEqual({ status: 'partial', reasonCode: null });
  });

  // T030: the plan states this outcome explicitly ("Each item passes validateEgress; a failing
  // item is not sent (status partial, schema_rejected)") — collectOne silently dropped a
  // schema-invalid item with no outcome signal at all until this field existed (a leaking test
  // adapter's bad item vanished without the source outcome ever saying so). Written first and
  // watched fail (TS2353 excess-property, `anyEgressRejected` not yet on the type) before the
  // field was added below.
  it('an item failed validateEgress and was dropped -> partial/schema_rejected (quickstart 43, 45)', () => {
    const outcome = deriveProvisionalSourceOutcome({
      kind: 'completed',
      items: [{ kind: 'repository_ref' } as never],
      gaps: [],
      truncated: false,
      anyEgressRejected: true,
    });
    expect(outcome).toEqual({ status: 'partial', reasonCode: 'schema_rejected' });
  });
});

describe('downgradeForRejectedItems (T019, "ingestion only ever makes the outcome worse")', () => {
  it('downgrades collected -> partial/schema_rejected when ingestion rejects an item', () => {
    expect(downgradeForRejectedItems({ status: 'collected', reasonCode: null }, true)).toEqual({
      status: 'partial',
      reasonCode: 'schema_rejected',
    });
  });

  it('leaves collected alone when nothing was rejected', () => {
    expect(downgradeForRejectedItems({ status: 'collected', reasonCode: null }, false)).toEqual({
      status: 'collected',
      reasonCode: null,
    });
  });

  it('never upgrades an already-worse outcome', () => {
    expect(downgradeForRejectedItems({ status: 'timed_out', reasonCode: 'timeout' }, true)).toEqual(
      {
        status: 'timed_out',
        reasonCode: 'timeout',
      },
    );
  });
});
