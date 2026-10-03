import { validateResultBatchEgress, type CollectionResultBatch } from '@healer/boundary-contract';

/** The batch did not conform to the boundary schema, so it was not sent (003 T008, FR-010, SC-002). */
export class EgressRefusedError extends Error {
  readonly reasonCode = 'schema_rejected' as const;
  constructor(readonly schemaErrorPaths: readonly string[]) {
    // paths only — a message built from the payload would be the leak this check exists to stop
    super(`result batch refused at egress: ${schemaErrorPaths.join(', ')}`);
    this.name = 'EgressRefusedError';
  }
}

/**
 * Egress validation on the runner (T008, 012 FR-022): nothing is handed to the transport unless it
 * conforms. This is one of two executions of the one schema package — the control plane runs its
 * own, independently, at ingress — because the runner a customer operates may not be this build.
 */
export function egress(batch: unknown): CollectionResultBatch {
  const result = validateResultBatchEgress(batch);
  if (!result.ok || result.batch === undefined) {
    throw new EgressRefusedError(result.schemaErrorPaths ?? []);
  }
  return result.batch;
}
