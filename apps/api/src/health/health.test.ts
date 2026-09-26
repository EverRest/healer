import { describe, expect, it } from 'vitest';
import { buildHealthReport } from './health.js';

const base = {
  service: 'healer-api',
  version: '0.5.0',
  build: 'local',
  runnerProtocolVersion: 1,
};

describe('health report', () => {
  it('is ok when every dependency is up', () => {
    const report = buildHealthReport({
      ...base,
      dependencies: [
        { name: 'postgres', state: 'up' },
        { name: 'redis', state: 'up' },
      ],
    });
    expect(report.status).toBe('ok');
    expect(report.version).toBe('0.5.0');
    expect(report.runnerProtocolVersion).toBe(1);
  });

  it('is down when any dependency is down — not ready to accept work it cannot finish', () => {
    expect(
      buildHealthReport({
        ...base,
        dependencies: [
          { name: 'postgres', state: 'down', detail: 'connection refused' },
          { name: 'redis', state: 'up' },
        ],
      }).status,
    ).toBe('down');
  });

  it('is degraded when a dependency is degraded', () => {
    expect(
      buildHealthReport({
        ...base,
        dependencies: [{ name: 'redis', state: 'degraded', detail: 'high latency' }],
      }).status,
    ).toBe('degraded');
  });

  it('never carries a connection string or a credential', () => {
    const report = buildHealthReport({
      ...base,
      dependencies: [{ name: 'postgres', state: 'down', detail: 'connection refused' }],
    });
    expect(JSON.stringify(report)).not.toMatch(/postgresql:\/\/|password|:\/\/[^"]*@/);
  });
});
