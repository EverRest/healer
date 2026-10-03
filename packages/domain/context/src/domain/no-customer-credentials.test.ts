import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '@healer/shared';

/**
 * 003 T032, FR-002, quickstart 46. Collection runs in the customer's plane because the credentials
 * to their systems are theirs. If the control plane could be configured with one, the hybrid split
 * would be a convention rather than a fact — so this searches the control plane's configuration for
 * a credential to any customer observability, repository, configuration or deployment system, and
 * the answer must be that none can exist.
 */
const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

const SYSTEMS =
  'LOKI|PROMETHEUS|GRAFANA|GITLAB|GITHUB|JENKINS|ARGOCD|ARGO|LAUNCHDARKLY|UNLEASH|FLAGSMITH|DATADOG|SENTRY|KUBE|KUBERNETES|OTEL_EXPORTER_OTLP';
const SECRETS =
  'TOKEN|API_KEY|APIKEY|KEY|PASSWORD|PASSWD|SECRET|CREDENTIAL|CREDENTIALS|USERNAME|HEADERS';
const CUSTOMER_CREDENTIAL = new RegExp(`\\b(?:${SYSTEMS})_[A-Z0-9_]*(?:${SECRETS})\\b`);

function* controlPlaneSources(dir: string): Generator<string> {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', 'generated', 'worktrees'].includes(entry.name)) continue;
      yield* controlPlaneSources(rel);
    } else if (/\.(ts|mjs|yml|yaml)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name))
      yield rel;
  }
}

describe('the control plane holds no credential to a customer system (003 T032, FR-002)', () => {
  it('its configuration schema has no key for one — an unknown variable is not even read', () => {
    const candidates = {
      LOKI_TOKEN: 'x',
      PROMETHEUS_PASSWORD: 'x',
      GRAFANA_API_KEY: 'x',
      GITLAB_TOKEN: 'x',
      CONFIG_FLAGS_API_KEY: 'x',
      DEPLOY_TOOL_SECRET: 'x',
    };
    const config = loadConfig({
      DATABASE_URL: 'postgres://u@h/db',
      REDIS_URL: 'redis://h',
      ...candidates,
    });
    expect(Object.keys(config).filter((key) => key in candidates)).toEqual([]);
  });

  it('no control-plane source or deployment file names one', () => {
    const files = [
      ...controlPlaneSources('packages'),
      ...controlPlaneSources('apps/api'),
      ...controlPlaneSources('apps/worker'),
      ...controlPlaneSources('apps/mcp-server'),
      ...controlPlaneSources('docker'),
    ].filter((file) => file !== 'docker/docker-compose.runner.yml');
    const offenders = files.filter((file) =>
      CUSTOMER_CREDENTIAL.test(readFileSync(join(ROOT, file), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('the pattern would catch one — a credential variable for a customer system is named by it', () => {
    for (const name of [
      'GITLAB_TOKEN',
      'LOKI_PASSWORD',
      'GRAFANA_API_KEY',
      'OTEL_EXPORTER_OTLP_HEADERS',
    ]) {
      expect(CUSTOMER_CREDENTIAL.test(name)).toBe(true);
    }
    // the control plane's own telemetry endpoint is not a customer credential
    expect(CUSTOMER_CREDENTIAL.test('OTEL_EXPORTER_OTLP_ENDPOINT')).toBe(false);
  });
});
