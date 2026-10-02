/**
 * Matches pino's `Logger.warn` shape structurally — same technique as `@healer/workflow`'s
 * `job-budget.ts` `AlertLogger` — so this package takes no dependency on pino itself. Shared by
 * `collect-discovery.ts` and `ingest-discovery-batch.ts` (review fix): both log a rejection/
 * timeout/unresolved-edge count, never a payload (security-and-tenancy.md — field-level messages
 * and counts only). Optional on every caller: a caller that supplies none just gets no log line.
 */
export interface DiscoveryLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}
