import { z } from 'zod';

/**
 * The only place in the monorepo that reads `process.env` (012 FR-043, FR-044; lint
 * pattern in R-01). Everything else takes typed values, so a missing variable fails at
 * process start with the variable named, rather than as `undefined` three layers in.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  HTTP_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  SERVICE_NAME: z.string().min(1).default('healer-api'),
  /** Read by the health endpoint and by the runner handshake; never inferred from the build. */
  RUNNER_PROTOCOL_VERSION: z.coerce.number().int().min(1).default(1),
});

export type Config = Readonly<z.infer<typeof schema>>;

export class ConfigurationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n  ${issues.join('\n  ')}`);
    this.name = 'ConfigurationError';
  }
}

/**
 * Validates and freezes the configuration. Call once at process start; fail fast.
 * `source` is a parameter so tests need no environment mutation.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigurationError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  return Object.freeze(parsed.data);
}

/**
 * `apps/runner`'s own configuration (012 T045). A separate schema, not an extension of `schema`
 * above: the runner has no direct database access, ever (backend-nestjs.md), so it must not
 * require `DATABASE_URL`/`REDIS_URL` the way every other deployable in this repo does. Living in
 * this same file keeps `process.env` reads confined to the one directory the lint rule
 * authorizes (`packages/shared/src/config/**`, R-01) without inventing a second authorized
 * location for a second app.
 */
const runnerSchema = z.object({
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  RUNNER_CONTROL_PLANE_URL: z.string().url(),
  RUNNER_TENANT_ID: z.string().min(1),
  RUNNER_NAME: z.string().min(1),
  RUNNER_IMAGE_VERSION: z.string().min(1),
  RUNNER_PROTOCOL_VERSION: z.coerce.number().int().min(1).default(1),
  RUNNER_CAPABILITIES: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((capability) => capability.trim())
        .filter((capability) => capability.length > 0),
    ),
  RUNNER_CPU_LIMIT: z.coerce.number().positive().default(1),
  RUNNER_MEMORY_MB_LIMIT: z.coerce.number().positive().default(512),
  RUNNER_MAX_CONCURRENT_RUNS: z.coerce.number().int().positive().default(1),
  RUNNER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  /** Bound for the directive idempotency seen-set (FR-028) — independent of heartbeat sizing on
   *  purpose: directive volume and heartbeat-retry volume are unrelated quantities, so one number
   *  must not do both jobs (review finding). 200 is a placeholder, same status as every other
   *  un-measured bound in this codebase (e.g. 001's `MAX_FINGERPRINT_FRAMES`) — no real fleet
   *  exists yet to measure in-flight directive concurrency against. */
  RUNNER_DIRECTIVE_SEEN_SET_SIZE: z.coerce.number().int().positive().default(200),
});

export type RunnerConfig = Readonly<z.infer<typeof runnerSchema>>;

export function loadRunnerConfig(source: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const parsed = runnerSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigurationError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  return Object.freeze(parsed.data);
}
