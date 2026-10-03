import { describe, expect, it } from 'vitest';
import { COLLECTOR_KEYS } from '@healer/boundary-contract';
import { configFlagsContextSource } from './config-flags/config-flags-context-source.js';
import { gitlabContextSource } from './gitlab/gitlab-context-source.js';
import { grafanaContextSource } from './grafana/grafana-context-source.js';
import { lokiContextSource } from './loki/loki-context-source.js';
import { otelContextSource } from './otel/otel-context-source.js';
import { prometheusContextSource } from './prometheus/prometheus-context-source.js';
import { skeletonContextSource } from './context-source.js';

const ADAPTERS = [
  lokiContextSource,
  prometheusContextSource,
  grafanaContextSource,
  otelContextSource,
  gitlabContextSource,
  configFlagsContextSource,
];

const REQUEST = {
  component: 'api',
  environment: 'production',
  window: { from: new Date(0), to: new Date(1) },
  limit: 10,
};

describe('context source skeletons (003 T005)', () => {
  it('serve exactly the closed collector list — the constitution v1 set and nothing beyond it', () => {
    const served = ADAPTERS.flatMap((a) => [...a.collectorKeys]).sort();
    expect(served).toEqual([...COLLECTOR_KEYS].sort());
    expect(ADAPTERS.map((a) => a.key).sort()).toEqual([
      'config-flags',
      'gitlab',
      'grafana',
      'loki',
      'otel',
      'prometheus',
    ]);
  });

  it('read nothing yet, and say nothing: an empty array, no throw', async () => {
    for (const adapter of ADAPTERS) {
      for (const key of adapter.collectorKeys) {
        await expect(adapter.read(key, REQUEST)).resolves.toEqual([]);
      }
    }
  });

  it('honour an already-aborted signal rather than ignoring it', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      lokiContextSource.read('loki_logs', { ...REQUEST, signal: controller.signal }),
    ).rejects.toThrow();
  });

  it('refuse a collector they do not serve', async () => {
    await expect(lokiContextSource.read('config_flags', REQUEST)).rejects.toThrow(/does not serve/);
    expect(skeletonContextSource('x', []).collectorKeys).toEqual([]);
  });
});
