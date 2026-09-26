import { pino, type Logger, type LoggerOptions } from 'pino';

/**
 * Structured logging (012 FR-034, FR-035). Two properties matter and both are
 * enforced here rather than left to call sites:
 *
 *  - every line carries `tenantId` and `correlationId` where they exist, so a line is
 *    attributable to a tenant and to one investigation;
 *  - secrets and customer content are redacted by path, because "do not log the payload"
 *    as a convention decays at the first debugging session.
 */
export const REDACTED = '[redacted]';

/** Paths never written, whatever a caller passes. Additions belong here, not at a call site. */
const redactPaths = [
  'password',
  'token',
  'secret',
  'credential',
  'credentialRef',
  'authorization',
  'apiKey',
  'body',
  'payload',
  'logBody',
  'sourceCode',
  'patch',
  'diff',
  '*.password',
  '*.token',
  '*.secret',
  '*.credential',
  '*.authorization',
  '*.apiKey',
  '*.body',
  '*.payload',
  'req.headers.authorization',
  'req.headers.cookie',
];

export interface LogContext {
  readonly tenantId?: string;
  readonly correlationId?: string;
}

export function createLogger(
  options: { level?: string; serviceName?: string } = {},
  destination?: Parameters<typeof pino>[1],
): Logger {
  const config: LoggerOptions = {
    level: options.level ?? 'info',
    base: { service: options.serviceName ?? 'healer' },
    redact: { paths: redactPaths, censor: REDACTED },
    formatters: { level: (label) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return destination ? pino(config, destination) : pino(config);
}

/** A child logger bound to one investigation. Prefer this over passing ids per call. */
export function withContext(logger: Logger, context: LogContext): Logger {
  return logger.child({ ...context });
}
