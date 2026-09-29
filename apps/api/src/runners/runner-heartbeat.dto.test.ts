import { describe, expect, it } from 'vitest';
import { runnerHeartbeatRequestSchema } from './runner-heartbeat.dto.js';

const VALID_BODY = {
  name: 'primary',
  protocolVersion: 1,
  imageVersion: '1.0.0',
  capabilities: ['read_logs'],
  resourceLimits: { cpu: 2, memoryMb: 2048, maxConcurrentRuns: 4 },
};

describe('runnerHeartbeatRequestSchema (012 T042, FR-018, FR-020)', () => {
  it('accepts the wire format from contracts/runner-protocol.md', () => {
    const result = runnerHeartbeatRequestSchema.safeParse(VALID_BODY);
    expect(result.success).toBe(true);
  });

  it('accepts FR-020s extra heartbeat-only fields, resourceState and clockOffsetMs', () => {
    const result = runnerHeartbeatRequestSchema.safeParse({
      ...VALID_BODY,
      resourceState: { activeRuns: 1, cpuPercent: 42 },
      clockOffsetMs: -150,
    });
    expect(result.success).toBe(true);
  });

  it('requires a name — the natural key runner_registration is unique on', () => {
    const { name: _name, ...withoutName } = VALID_BODY;
    expect(runnerHeartbeatRequestSchema.safeParse(withoutName).success).toBe(false);
  });

  it('requires protocolVersion', () => {
    const { protocolVersion: _p, ...rest } = VALID_BODY;
    expect(runnerHeartbeatRequestSchema.safeParse(rest).success).toBe(false);
  });

  it('requires resourceLimits with all three fields', () => {
    expect(
      runnerHeartbeatRequestSchema.safeParse({ ...VALID_BODY, resourceLimits: { cpu: 2 } }).success,
    ).toBe(false);
  });

  it('rejects an unknown top-level field — the closed shape this endpoint accepts', () => {
    expect(runnerHeartbeatRequestSchema.safeParse({ ...VALID_BODY, extra: 'nope' }).success).toBe(
      false,
    );
  });

  it('capabilities defaults were never assumed — an empty array is valid (a fresh runner may declare none)', () => {
    expect(
      runnerHeartbeatRequestSchema.safeParse({ ...VALID_BODY, capabilities: [] }).success,
    ).toBe(true);
  });
});
