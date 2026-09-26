import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Correlation (012 FR-032). One identifier threads a single investigation through every
 * HTTP request, job, model call, log line and span, so "what happened to issue X" is one
 * query rather than a reconstruction.
 *
 * Kept deliberately small: an `AsyncLocalStorage` holding the identifier, and OpenTelemetry
 * reading from it. A full SDK bootstrap belongs to the process entry point (apps), not to a
 * library every package imports.
 */
export type CorrelationId = string;

const storage = new AsyncLocalStorage<CorrelationId>();

export function newCorrelationId(): CorrelationId {
  return randomUUID();
}

/** Runs `fn` with a correlation identifier bound to the async context. */
export function withCorrelation<T>(correlationId: CorrelationId, fn: () => T): T {
  return storage.run(correlationId, fn);
}

/**
 * The identifier in force, or undefined outside a correlated scope. Undefined rather than
 * a fresh one: inventing an identifier here would produce a second trace for the same work,
 * which reads as two investigations.
 */
export function currentCorrelationId(): CorrelationId | undefined {
  return storage.getStore();
}
