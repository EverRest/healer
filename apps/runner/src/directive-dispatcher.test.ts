import { describe, expect, it, vi } from 'vitest';
import type { ControlPlaneDirective, DirectiveEnvelope } from '@healer/boundary-contract';
import {
  BoundedSeenSet,
  dispatchDirectives,
  type DirectiveDispatchLogger,
} from './directive-dispatcher.js';

const capabilityQuery: ControlPlaneDirective = {
  kind: 'capability_query',
  requested: ['inference'],
};

function envelope(
  id: string,
  directive: ControlPlaneDirective = capabilityQuery,
): DirectiveEnvelope {
  return { id, directive };
}

function fakeLogger(): DirectiveDispatchLogger {
  return { error: vi.fn() };
}

describe('BoundedSeenSet (012 T051, FR-028)', () => {
  it('reports a fresh id as unseen, then seen once marked', () => {
    const seen = new BoundedSeenSet(2);
    expect(seen.hasSeen('a')).toBe(false);
    seen.markSeen('a');
    expect(seen.hasSeen('a')).toBe(true);
  });

  it("reports its current occupancy via .size — 012 T048, the diagnostics bundle's queue depth", () => {
    const seen = new BoundedSeenSet(2);
    expect(seen.size).toBe(0);
    seen.markSeen('a');
    expect(seen.size).toBe(1);
    seen.markSeen('b');
    seen.markSeen('c'); // overflow: 'a' evicted, size stays at the bound
    expect(seen.size).toBe(2);
  });

  it('drops the oldest id on overflow, same drop-oldest policy as OutboundBuffer', () => {
    const seen = new BoundedSeenSet(2);
    seen.markSeen('a');
    seen.markSeen('b');
    seen.markSeen('c'); // overflow: 'a' evicted
    expect(seen.hasSeen('a')).toBe(false);
    expect(seen.hasSeen('b')).toBe(true);
    expect(seen.hasSeen('c')).toBe(true);
  });

  it('refreshes recency instead of evicting the re-marked id — the oldest untouched id is evicted instead', () => {
    const seen = new BoundedSeenSet(2);
    seen.markSeen('a');
    seen.markSeen('b');
    seen.markSeen('a'); // re-mark: 'a' is now the most recent, 'b' becomes the oldest
    seen.markSeen('c'); // overflow: 'b' (the actual oldest) is evicted, not 'a'
    expect(seen.hasSeen('a')).toBe(true);
    expect(seen.hasSeen('b')).toBe(false);
    expect(seen.hasSeen('c')).toBe(true);
  });

  it('rejects a non-positive bound', () => {
    expect(() => new BoundedSeenSet(0)).toThrow();
    expect(() => new BoundedSeenSet(-1)).toThrow();
  });
});

describe('dispatchDirectives (012 T051, FR-028 — a directive delivered twice executes once)', () => {
  it('executes a new directive exactly once', async () => {
    const seen = new BoundedSeenSet(10);
    const handle = vi.fn();
    await dispatchDirectives([envelope('d1')], seen, handle, fakeLogger());
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledWith(capabilityQuery);
  });

  it('the same directive id arriving across two separate heartbeat response cycles executes once', async () => {
    const seen = new BoundedSeenSet(10);
    const handle = vi.fn();
    const logger = fakeLogger();
    await dispatchDirectives([envelope('d1')], seen, handle, logger); // cycle 1
    await dispatchDirectives([envelope('d1')], seen, handle, logger); // cycle 2, redelivered
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('a different id in the same cycle still executes', async () => {
    const seen = new BoundedSeenSet(10);
    const handle = vi.fn();
    await dispatchDirectives([envelope('d1'), envelope('d2')], seen, handle, fakeLogger());
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it('marks a directive seen only after its handler succeeds, so a failed attempt is retried, not foreclosed', async () => {
    const seen = new BoundedSeenSet(10);
    const logger = fakeLogger();
    const handle = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);

    await dispatchDirectives([envelope('d1')], seen, handle, logger); // fails
    expect(seen.hasSeen('d1')).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ directiveId: 'd1', directiveKind: 'capability_query' }),
      expect.any(String),
    );

    await dispatchDirectives([envelope('d1')], seen, handle, logger); // redelivered, now succeeds
    expect(handle).toHaveBeenCalledTimes(2);
    expect(seen.hasSeen('d1')).toBe(true);
  });

  it('a later directive in the same batch still runs after an earlier one throws', async () => {
    const seen = new BoundedSeenSet(10);
    const failing: ControlPlaneDirective = { kind: 'capability_query', requested: ['fail-me'] };
    const handle = vi.fn().mockImplementation((directive: ControlPlaneDirective) => {
      if (directive === failing) throw new Error('boom');
    });

    await dispatchDirectives([envelope('d1', failing), envelope('d2')], seen, handle, fakeLogger());

    expect(handle).toHaveBeenCalledTimes(2);
    expect(seen.hasSeen('d1')).toBe(false); // failed — eligible for retry
    expect(seen.hasSeen('d2')).toBe(true); // ran despite d1's failure
  });

  it('a redelivered id is not re-executed even after more than the bound worth of other ids pass through', async () => {
    const bound = 3;
    const seen = new BoundedSeenSet(bound);
    const logger = fakeLogger();
    const sticky: ControlPlaneDirective = {
      kind: 'capability_query',
      requested: ['sticky-marker'],
    };
    const handle = vi.fn();

    await dispatchDirectives([envelope('sticky', sticky)], seen, handle, logger);
    for (let i = 0; i < bound + 2; i++) {
      // 'sticky' keeps arriving alongside a flood of otherwise-unrelated new ids — more of them
      // than the bound holds — so a plain FIFO seen-set would evict and re-execute it.
      await dispatchDirectives(
        [envelope('sticky', sticky), envelope(`new-${i}`)],
        seen,
        handle,
        logger,
      );
    }

    const stickyCalls = handle.mock.calls.filter(([directive]) => directive === sticky);
    expect(stickyCalls).toHaveLength(1);
  });
});
