import { describe, expect, it } from 'vitest';
import { CURRENT_PROTOCOL_VERSION, resolveHandshake } from './handshake.js';

const BASE_HANDSHAKE = {
  protocolVersion: CURRENT_PROTOCOL_VERSION,
  imageVersion: '1.0.0',
  capabilities: ['read_logs', 'write_remediation'],
  resourceLimits: { cpu: 2, memoryMb: 2048, maxConcurrentRuns: 4 },
};

describe('resolveHandshake — the compatibility matrix (012 T039, R-03, quickstart 17, 18)', () => {
  it('is active on the current supported version with every required capability declared', () => {
    const result = resolveHandshake(BASE_HANDSHAKE, [
      { name: 'read_logs', kind: 'read' },
      { name: 'write_remediation', kind: 'write' },
    ]);
    expect(result.status).toBe('active');
    expect(result.resolvedCapabilities).toEqual(['read_logs', 'write_remediation']);
  });

  it('degrades when two minor versions back and a read-only capability is missing (quickstart 17)', () => {
    const result = resolveHandshake(
      { ...BASE_HANDSHAKE, protocolVersion: CURRENT_PROTOCOL_VERSION - 2, capabilities: [] },
      [{ name: 'read_logs', kind: 'read' }],
    );
    expect(result.status).toBe('degraded');
    expect(result.resolutions[0]).toMatchObject({ capability: 'read_logs', outcome: 'degraded' });
  });

  it('refuses below the compatibility floor — more than two minor versions behind (quickstart 18)', () => {
    const result = resolveHandshake(
      { ...BASE_HANDSHAKE, protocolVersion: CURRENT_PROTOCOL_VERSION - 3 },
      [{ name: 'read_logs', kind: 'read' }],
    );
    expect(result.status).toBe('refused');
    expect(result.refusedReason).toMatch(/upgrade required/);
  });

  it('refuses a superseded version once the successor has existed past the 90-day floor, even within the version window', () => {
    const result = resolveHandshake(
      { ...BASE_HANDSHAKE, protocolVersion: CURRENT_PROTOCOL_VERSION - 1 },
      [{ name: 'read_logs', kind: 'read' }],
      {
        now: new Date('2026-06-01T00:00:00Z'),
        // Version+1 (the one that superseded the runner's) shipped 2026-01-01 — over 90 days ago.
        protocolReleasedAt: () => new Date('2026-01-01T00:00:00Z'),
      },
    );
    expect(result.status).toBe('refused');
    expect(result.refusedReason).toMatch(/90-day floor/);
  });

  it('never applies the 90-day floor to the current version, however long it has shipped', () => {
    const result = resolveHandshake(BASE_HANDSHAKE, [{ name: 'read_logs', kind: 'read' }], {
      now: new Date('2030-01-01T00:00:00Z'),
      // Would look "superseded 4 years ago" under the old, wrong logic — but this IS the
      // current version, so there is nothing to upgrade to and it must not be refused.
      protocolReleasedAt: () => new Date('2026-01-01T00:00:00Z'),
    });
    expect(result.status).toBe('active');
  });

  it('degrades, never refuses, when only a read capability is missing (quickstart 19)', () => {
    const result = resolveHandshake({ ...BASE_HANDSHAKE, capabilities: ['write_remediation'] }, [
      { name: 'read_logs', kind: 'read' },
      { name: 'write_remediation', kind: 'write' },
    ]);
    expect(result.status).toBe('degraded');
  });

  it('refuses, never degrades, when a write capability is missing (quickstart 19)', () => {
    const result = resolveHandshake({ ...BASE_HANDSHAKE, capabilities: ['read_logs'] }, [
      { name: 'read_logs', kind: 'read' },
      { name: 'write_remediation', kind: 'write' },
    ]);
    expect(result.status).toBe('refused');
    expect(result.refusedReason).toMatch(/write_remediation/);
  });

  it('never resolves an undeclared capability as available', () => {
    const result = resolveHandshake({ ...BASE_HANDSHAKE, capabilities: [] }, [
      { name: 'read_logs', kind: 'read' },
    ]);
    expect(result.resolvedCapabilities).toEqual([]);
  });
});
