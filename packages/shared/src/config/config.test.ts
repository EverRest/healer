import { describe, expect, it } from 'vitest';
import { ConfigurationError, loadConfig, loadRunnerConfig } from './index.js';

const valid = {
  DATABASE_URL: 'postgresql://healer:healer@localhost:5432/healer',
  REDIS_URL: 'redis://localhost:6379',
};

const validRunner = {
  RUNNER_CONTROL_PLANE_URL: 'https://control-plane.example.com',
  RUNNER_TENANT_ID: 'tenant-1',
  RUNNER_NAME: 'runner-1',
  RUNNER_IMAGE_VERSION: '0.5.0',
};

describe('loadConfig', () => {
  it('applies declared defaults', () => {
    const config = loadConfig(valid);
    expect(config.NODE_ENV).toBe('development');
    expect(config.HTTP_PORT).toBe(3000);
    expect(config.RUNNER_PROTOCOL_VERSION).toBe(1);
  });

  it('names every missing or malformed variable instead of failing later as undefined', () => {
    try {
      loadConfig({ DATABASE_URL: 'not-a-url' });
      expect.unreachable('configuration must not load');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const issues = (error as ConfigurationError).issues.join(' ');
      expect(issues).toContain('DATABASE_URL');
      expect(issues).toContain('REDIS_URL');
    }
  });

  it('is frozen, so no later code can reconfigure the process', () => {
    const config = loadConfig(valid);
    expect(() => {
      (config as { HTTP_PORT: number }).HTTP_PORT = 9999;
    }).toThrow();
  });
});

describe('loadRunnerConfig (012 T045 — apps/runner has no DATABASE_URL/REDIS_URL, ever)', () => {
  it('applies declared defaults, with no database or queue variable required', () => {
    const config = loadRunnerConfig(validRunner);
    expect(config.RUNNER_PROTOCOL_VERSION).toBe(1);
    expect(config.RUNNER_HEARTBEAT_INTERVAL_MS).toBe(30_000);
    expect(config.RUNNER_DIRECTIVE_SEEN_SET_SIZE).toBe(200);
    expect(config.RUNNER_CAPABILITIES).toEqual([]);
  });

  it('parses a comma-separated capability list', () => {
    const config = loadRunnerConfig({ ...validRunner, RUNNER_CAPABILITIES: 'inference, egress ' });
    expect(config.RUNNER_CAPABILITIES).toEqual(['inference', 'egress']);
  });

  it('names every missing or malformed variable instead of failing later as undefined', () => {
    try {
      loadRunnerConfig({ RUNNER_CONTROL_PLANE_URL: 'not-a-url' });
      expect.unreachable('configuration must not load');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const issues = (error as ConfigurationError).issues.join(' ');
      expect(issues).toContain('RUNNER_CONTROL_PLANE_URL');
      expect(issues).toContain('RUNNER_TENANT_ID');
      expect(issues).toContain('RUNNER_NAME');
      expect(issues).toContain('RUNNER_IMAGE_VERSION');
    }
  });

  it('is frozen, so no later code can reconfigure the process', () => {
    const config = loadRunnerConfig(validRunner);
    expect(() => {
      (config as { RUNNER_NAME: string }).RUNNER_NAME = 'other';
    }).toThrow();
  });

  it("refuses a heartbeat interval long enough to push the drain timeout past docker-compose.runner.yml's stop_grace_period (012 T050 review)", () => {
    // At 32_001ms the derived drain timeout (heartbeat-client.ts's computeHeartbeatTimeoutMs,
    // floor(interval * 0.5), plus main.ts's 2s DRAIN_SAFETY_MARGIN_MS) would exceed 18_000ms —
    // too close to the compose file's 20s stop_grace_period for Docker's own signal-delivery
    // overhead to be safely inside it. This must fail loudly at config load, not silently ship a
    // config that reintroduces the "SIGKILL before drain finishes" bug the T050 review found.
    try {
      loadRunnerConfig({ ...validRunner, RUNNER_HEARTBEAT_INTERVAL_MS: '32001' });
      expect.unreachable('configuration must not load');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).issues.join(' ')).toContain(
        'RUNNER_HEARTBEAT_INTERVAL_MS',
      );
    }
  });

  it('accepts the longest heartbeat interval that still keeps the drain timeout safely under the shipped stop_grace_period', () => {
    const config = loadRunnerConfig({ ...validRunner, RUNNER_HEARTBEAT_INTERVAL_MS: '32000' });
    expect(config.RUNNER_HEARTBEAT_INTERVAL_MS).toBe(32_000);
  });
});
