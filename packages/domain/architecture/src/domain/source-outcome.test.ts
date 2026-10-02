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
      egressRejectedCount: 0,
    });
    expect(outcome).toEqual({ status: 'collected', reasonCode: null });
  });

  it('completed with nothing at all -> collected/empty_result', () => {
    const outcome = deriveProvisionalSourceOutcome({
      kind: 'completed',
      items: [],
      gaps: [],
      truncated: false,
      egressRejectedCount: 0,
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
      egressRejectedCount: 0,
    });
    expect(outcome).toEqual({ status: 'partial', reasonCode: null });
  });

  it('item cap truncated the results -> partial, no reason code (the gap says truncated)', () => {
    const outcome = deriveProvisionalSourceOutcome({
      kind: 'completed',
      items: [{ kind: 'repository_ref' } as never],
      gaps: [],
      truncated: true,
      egressRejectedCount: 0,
    });
    expect(outcome).toEqual({ status: 'partial', reasonCode: null });
  });

  // Review fix: every egress-rejected item used to vanish with no trace — a source whose every
  // item failed validateEgress read as collected/empty_result instead of partial/schema_rejected.
  it('an egress-rejected item -> partial/schema_rejected, even with zero surviving items', () => {
    const outcome = deriveProvisionalSourceOutcome({
      kind: 'completed',
      items: [],
      gaps: [],
      truncated: false,
      egressRejectedCount: 1,
    });
    expect(outcome).toEqual({ status: 'partial', reasonCode: 'schema_rejected' });
  });

  it('an egress rejection outranks a mere truncation or region gap', () => {
    const outcome = deriveProvisionalSourceOutcome({
      kind: 'completed',
      items: [{ kind: 'repository_ref' } as never],
      gaps: [{ kind: 'collection_gap', what: 'x', why: 'y', withheldByRedaction: false }],
      truncated: true,
      egressRejectedCount: 1,
    });
    expect(outcome.reasonCode).toBe('schema_rejected');
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
