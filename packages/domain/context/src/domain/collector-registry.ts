import type { z } from 'zod';
import {
  COLLECTOR_KEYS,
  COLLECTOR_PARAMETER_SCHEMAS,
  FOLLOW_UP_ONLY_COLLECTORS,
  type CollectorKey,
  type ItemClass,
} from '@healer/boundary-contract';

/**
 * The declared collectors (003 T011, FR-005, R-12). `COLLECTOR_REGISTRY` is a
 * `Record<CollectorKey, …>`: a collector added to the boundary's closed list with no declaration
 * here, or declared here without being on the list, is a compile error. `collectorKey` is therefore
 * an enum everywhere it travels — a source outside the declared set is not a string that fails a
 * validator, it is a value the type cannot hold.
 */
export interface CollectorDeclaration {
  readonly key: CollectorKey;
  /** What it may emit — members of 012's closed shape set, by `kind` (R-03). */
  readonly itemClasses: readonly ItemClass[];
  readonly parameterSchema: z.ZodTypeAny;
  readonly defaultTimeoutMs: number;
  /** The runner capability that must be declared for this collector to run (012 R-03). */
  readonly requiredCapability: string;
  /** Reachable only as a follow-up pass, inheriting its cap, validation and audit (R-12). */
  readonly followUpOnly: boolean;
}

function declare(
  key: CollectorKey,
  itemClasses: readonly ItemClass[],
  defaultTimeoutMs: number,
): CollectorDeclaration {
  return {
    key,
    itemClasses,
    parameterSchema: COLLECTOR_PARAMETER_SCHEMAS[key],
    defaultTimeoutMs,
    requiredCapability: `collect:${key}`,
    followUpOnly: FOLLOW_UP_ONLY_COLLECTORS.includes(key),
  };
}

// Timeouts are a placeholder pending the stage-0 incident audit (spec assumptions: configuration
// tuned from S0-1, not constants) — the registry's default, overridden per plan by the ruleset.
export const COLLECTOR_REGISTRY: Readonly<Record<CollectorKey, CollectorDeclaration>> = {
  loki_logs: declare('loki_logs', ['error_signature', 'stack_frame'], 10_000),
  otel_traces: declare('otel_traces', ['trace_shape'], 10_000),
  prometheus_metrics: declare('prometheus_metrics', ['metric_delta'], 10_000),
  grafana_alerts: declare('grafana_alerts', ['tool_output_summary'], 10_000),
  gitlab_commits: declare('gitlab_commits', ['commit_ref'], 10_000),
  gitlab_merge_requests: declare('gitlab_merge_requests', ['pull_request_ref'], 10_000),
  gitlab_deployments: declare('gitlab_deployments', ['deploy_ref'], 10_000),
  config_flags: declare('config_flags', ['config_key_ref'], 10_000),
  source_file: declare('source_file', ['file_path'], 15_000),
};

export function declaredCollectors(): readonly CollectorDeclaration[] {
  return COLLECTOR_KEYS.map((key) => COLLECTOR_REGISTRY[key]);
}

/** The shape stored in `collector_registration.parameter_schema`: declared field names only. */
export function describeParameterSchema(schema: z.ZodTypeAny): { fields: string[] } {
  const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
  return { fields: Object.keys(shape).sort() };
}
