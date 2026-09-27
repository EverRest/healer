import { MAX_SIGNAL_BATCH_SIZE } from '@healer/domain-issues';
import { z } from 'zod';

// Not `.strict()` (review finding): a provider adding a new field to its payload must not turn
// every one of its future deliveries into a 400 — FR-019 says signals must not be lost, and an
// unknown field is forward-compatible noise, not a malformed signal. Unrecognized keys are
// dropped, not rejected.
const errorSignatureSchema = z.object({
  exceptionType: z.string().optional(),
  frames: z.array(z.string()).optional(),
  endpointTemplate: z.string().optional(),
  errorCode: z.string().optional(),
});

const signalSchema = z.object({
  // `{ offset: true }` (review finding): plain `.datetime()` rejects a valid RFC 3339 timestamp
  // with a timezone offset (`+02:00`), accepting only a literal `Z` — confirmed empirically.
  observedAt: z.string().datetime({ offset: true }),
  component: z.string(),
  environment: z.string(),
  errorSignature: errorSignatureSchema,
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  traceId: z.string().optional(),
  deploymentRef: z.string().optional(),
});

/**
 * Matches `specs/001-issue-and-evidence/contracts/openapi.yaml`'s `Signal` schema. The batch cap
 * is `MAX_SIGNAL_BATCH_SIZE` (`@healer/domain-issues`) — the same constant `enqueueSignalBatch`
 * enforces, not a second hardcoded `1000` (review finding: two copies of the same number is the
 * kind of closed list this repo's own rules single out — the DTO enforcing a different value than
 * the command would silently make the command's own check unreachable from this endpoint).
 */
export const ingestSignalsRequestSchema = z
  .object({
    signals: z.array(signalSchema).max(MAX_SIGNAL_BATCH_SIZE),
  })
  .strict();

export type IngestSignalsRequest = z.infer<typeof ingestSignalsRequestSchema>;
