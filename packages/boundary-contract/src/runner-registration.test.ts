import { describe, expect, it } from 'vitest';
import { findStaleRunners, HEARTBEAT_STALE_THRESHOLD_MS } from './runner-registration.js';
import type { RunnerRegistrationSnapshot } from './runner-registration.js';

const NOW = new Date('2026-01-01T00:00:00Z');

function runner(overrides: Partial<RunnerRegistrationSnapshot> = {}): RunnerRegistrationSnapshot {
  return {
    id: 'runner-1',
    tenantId: 'tenant-1',
    name: 'default',
    protocolVersion: 1,
    capabilities: [],
    imageVersion: '1.0.0',
    status: 'active',
    lastHeartbeatAt: NOW,
    ...overrides,
  };
}

describe('findStaleRunners (012 T042, FR-020) — the twin of periodic-checks.ts', () => {
  it('returns an active runner whose last heartbeat is older than the threshold', () => {
    const stale = runner({
      lastHeartbeatAt: new Date(NOW.getTime() - HEARTBEAT_STALE_THRESHOLD_MS - 1),
    });
    expect(findStaleRunners([stale], NOW)).toEqual([stale]);
  });

  it('does not return a runner whose heartbeat is within the threshold', () => {
    const fresh = runner({
      lastHeartbeatAt: new Date(NOW.getTime() - HEARTBEAT_STALE_THRESHOLD_MS + 1),
    });
    expect(findStaleRunners([fresh], NOW)).toEqual([]);
  });

  it('does not return a degraded runner past the threshold either — degraded still accepts read-only work', () => {
    const stale = runner({
      status: 'degraded',
      lastHeartbeatAt: new Date(NOW.getTime() - HEARTBEAT_STALE_THRESHOLD_MS - 1),
    });
    expect(findStaleRunners([stale], NOW)).toEqual([stale]);
  });

  it('never returns an already-refused runner — it is already shown as unavailable', () => {
    const refused = runner({
      status: 'refused',
      lastHeartbeatAt: new Date(NOW.getTime() - HEARTBEAT_STALE_THRESHOLD_MS - 1),
    });
    expect(findStaleRunners([refused], NOW)).toEqual([]);
  });

  it('never returns a revoked runner', () => {
    const revoked = runner({
      status: 'revoked',
      lastHeartbeatAt: new Date(NOW.getTime() - HEARTBEAT_STALE_THRESHOLD_MS - 1),
    });
    expect(findStaleRunners([revoked], NOW)).toEqual([]);
  });

  it('accepts a caller-supplied threshold instead of the default', () => {
    const runners = [runner({ lastHeartbeatAt: new Date(NOW.getTime() - 1000) })];
    expect(findStaleRunners(runners, NOW, 500)).toEqual(runners);
    expect(findStaleRunners(runners, NOW, 5000)).toEqual([]);
  });
});
