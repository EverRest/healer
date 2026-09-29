import { describe, expect, it, vi } from 'vitest';
import type { ControlPlaneDirective } from '@healer/boundary-contract';
import {
  BoundedSeenSet,
  dispatchDirectives,
  type DirectiveEnvelope,
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

describe('BoundedSeenSet (012 T051, FR-028)', () => {
  it('reports a fresh id as unseen, then seen once marked', () => {
    const seen = new BoundedSeenSet(2);
    expect(seen.hasSeen('a')).toBe(false);
    seen.markSeen('a');
    expect(seen.hasSeen('a')).toBe(true);
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

  it('marking an already-seen id again does not evict anything', () => {
    const seen = new BoundedSeenSet(2);
    seen.markSeen('a');
    seen.markSeen('b');
    seen.markSeen('a'); // re-mark, not a new entry
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
    await dispatchDirectives([envelope('d1')], seen, handle);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledWith(capabilityQuery);
  });

  it('the same directive id arriving across two separate heartbeat response cycles executes once', async () => {
    const seen = new BoundedSeenSet(10);
    const handle = vi.fn();
    await dispatchDirectives([envelope('d1')], seen, handle); // cycle 1
    await dispatchDirectives([envelope('d1')], seen, handle); // cycle 2, redelivered
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('a different id in the same cycle still executes', async () => {
    const seen = new BoundedSeenSet(10);
    const handle = vi.fn();
    await dispatchDirectives([envelope('d1'), envelope('d2')], seen, handle);
    expect(handle).toHaveBeenCalledTimes(2);
  });
});
