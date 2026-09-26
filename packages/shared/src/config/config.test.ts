import { describe, expect, it } from 'vitest';
import { ConfigurationError, loadConfig } from './index.js';

const valid = {
  DATABASE_URL: 'postgresql://healer:healer@localhost:5432/healer',
  REDIS_URL: 'redis://localhost:6379',
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
