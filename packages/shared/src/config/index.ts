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
