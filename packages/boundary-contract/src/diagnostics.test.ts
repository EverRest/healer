import { describe, expect, it } from 'vitest';
import { buildDiagnosticsBundle, HEARTBEAT_LATENCY_BUCKETS_MS } from './diagnostics.js';

const emptyHistogram = {
  bucketsMs: HEARTBEAT_LATENCY_BUCKETS_MS,
  counts: HEARTBEAT_LATENCY_BUCKETS_MS.map(() => 0),
  overflowCount: 0,
};

function baseInput() {
  return {
    imageVersion: '0.5.0',
    protocolVersion: 1,
    capabilities: ['inference'],
    configuration: { RUNNER_NAME: 'set' as const, RUNNER_CPU_LIMIT: 'default' as const },
    queueDepths: { directiveSeenSet: 3 },
    heartbeatLatencyHistogramMs: emptyHistogram,
    errorSignatures: { 'network error': 2 },
    recentExchanges: [
      { timestamp: '2026-01-01T00:00:00.000Z', schema: 'heartbeat-request', byteSize: 42 },
    ],
    now: () => new Date('2026-09-30T00:00:00.000Z'),
  };
}

describe('buildDiagnosticsBundle (012 T048, FR-024, contracts/runner-protocol.md Diagnostics (R-06))', () => {
  it('assembles exactly the declared fact families, stamped with a generation time', () => {
    const bundle = buildDiagnosticsBundle(baseInput());
    expect(bundle).toEqual({
      generatedAt: '2026-09-30T00:00:00.000Z',
      versions: { imageVersion: '0.5.0', protocolVersion: 1 },
      capabilities: ['inference'],
      configuration: { RUNNER_NAME: 'set', RUNNER_CPU_LIMIT: 'default' },
      queueDepths: { directiveSeenSet: 3 },
      heartbeatLatencyHistogramMs: emptyHistogram,
      errorSignatures: { 'network error': 2 },
      recentExchanges: [
        { timestamp: '2026-01-01T00:00:00.000Z', schema: 'heartbeat-request', byteSize: 42 },
      ],
    });
  });

  it('defaults `now` to the real clock when not injected', () => {
    const { now: _now, ...input } = baseInput();
    const before = Date.now();
    const bundle = buildDiagnosticsBundle(input);
    const after = Date.now();
    const generatedAtMs = new Date(bundle.generatedAt).getTime();
    expect(generatedAtMs).toBeGreaterThanOrEqual(before);
    expect(generatedAtMs).toBeLessThanOrEqual(after);
  });

  it('never invents a fact family the input does not carry — no customer data, no source, no log bodies', () => {
    const bundle = buildDiagnosticsBundle(baseInput());
    expect(Object.keys(bundle).sort()).toEqual(
      [
        'generatedAt',
        'versions',
        'capabilities',
        'configuration',
        'queueDepths',
        'heartbeatLatencyHistogramMs',
        'errorSignatures',
        'recentExchanges',
      ].sort(),
    );
  });
});
