import { describe, expect, it } from 'vitest';
import { HeartbeatTransportError } from './heartbeat-client.js';
import { DiagnosticsState, MAX_RECENT_EXCHANGES } from './diagnostics-state.js';

describe('DiagnosticsState (012 T048 — runner-local accumulation for the support diagnostic bundle, FR-024)', () => {
  it('starts with an empty snapshot', () => {
    const state = new DiagnosticsState();
    const snapshot = state.snapshot();
    expect(snapshot.errorSignatures).toEqual({});
    expect(snapshot.recentExchanges).toEqual([]);
    expect(snapshot.heartbeatLatencyHistogramMs.counts.every((c) => c === 0)).toBe(true);
    expect(snapshot.heartbeatLatencyHistogramMs.overflowCount).toBe(0);
  });

  it('records a successful heartbeat: latency bucketed, request and response recorded as schema id + byte size only', () => {
    const state = new DiagnosticsState();
    state.recordHeartbeatSuccess(30, 120, 340);
    const snapshot = state.snapshot();

    expect(snapshot.recentExchanges).toEqual([
      expect.objectContaining({ schema: 'heartbeat-request', byteSize: 120 }),
      expect.objectContaining({ schema: 'heartbeat-response', byteSize: 340 }),
    ]);
    const totalCounted = snapshot.heartbeatLatencyHistogramMs.counts.reduce((a, b) => a + b, 0);
    expect(totalCounted).toBe(1);
  });

  it('buckets a latency past every declared bound into overflowCount, not silently into the last bucket', () => {
    const state = new DiagnosticsState();
    state.recordHeartbeatSuccess(999_999, 10, 10);
    expect(state.snapshot().heartbeatLatencyHistogramMs.overflowCount).toBe(1);
  });

  it('records a failed heartbeat: only the request exchange (no response was ever received) and a normalized error signature', () => {
    const state = new DiagnosticsState();
    state.recordHeartbeatFailure(
      15,
      120,
      new HeartbeatTransportError('heartbeat POST failed: MARKER-NETWORK-DETAIL'),
    );
    const snapshot = state.snapshot();

    expect(snapshot.recentExchanges).toEqual([
      expect.objectContaining({ schema: 'heartbeat-request', byteSize: 120 }),
    ]);
    expect(snapshot.errorSignatures).toEqual({ 'network error': 1 });
  });

  it('tallies repeated occurrences of the same normalized signature by count, never by storing each raw message', () => {
    const state = new DiagnosticsState();
    state.recordHeartbeatFailure(1, 1, new HeartbeatTransportError('heartbeat POST returned 503'));
    state.recordHeartbeatFailure(1, 1, new HeartbeatTransportError('heartbeat POST returned 503'));
    state.recordHeartbeatFailure(1, 1, new HeartbeatTransportError('heartbeat POST returned 500'));
    expect(state.snapshot().errorSignatures).toEqual({ 'non-2xx: 503': 2, 'non-2xx: 500': 1 });
  });

  it('keeps only the last N exchanges, dropping the oldest on overflow', () => {
    const state = new DiagnosticsState();
    for (let i = 0; i < MAX_RECENT_EXCHANGES + 5; i += 1) {
      state.recordHeartbeatSuccess(1, i, i);
    }
    const exchanges = state.snapshot().recentExchanges;
    // Two exchanges (request + response) per successful heartbeat, bounded at MAX_RECENT_EXCHANGES.
    expect(exchanges.length).toBe(MAX_RECENT_EXCHANGES);
    // The oldest cycles (i = 0..4) must be gone; the newest (i = MAX_RECENT_EXCHANGES + 4) present.
    expect(exchanges.some((e) => e.byteSize === 0)).toBe(false);
    expect(exchanges[exchanges.length - 1]?.byteSize).toBe(MAX_RECENT_EXCHANGES + 4);
  });
});
