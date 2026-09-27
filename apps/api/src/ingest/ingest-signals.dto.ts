import { MAX_SIGNAL_BATCH_SIZE } from '@healer/domain-issues';
import { z } from 'zod';

// Not `.strict()` (review finding): a provider adding a new field to its payload must not turn
// every one of its future deliveries into a 400 — FR-019 says signals must not be lost, and an
// unknown field is forward-compatible noise, not a malformed signal. Unrecognized keys are
// dropped, not rejected.
//
// Every field here is `.catch(undefined)` (001 T024, quickstart 20, "issue created from what
// parsed"): none of these are required to compute a fingerprint or create an issue, so a wrongly
// typed `frames` must not sink the rest of a signal that otherwise parsed fine — only the one
// malformed field is dropped, silently to the caller (it was never load-bearing) but never
// silently to the batch as a whole.
const errorSignatureSchema = z.object({
  exceptionType: z.string().optional().catch(undefined),
  frames: z.array(z.string()).optional().catch(undefined),
  endpointTemplate: z.string().optional().catch(undefined),
  errorCode: z.string().optional().catch(undefined),
});

/**
 * `observedAt`, `component`, `environment` and `errorSignature` (the object, not its fields —
 * see above) stay strictly required: a signal missing one of these has no identity to fingerprint
 * or group by, so there is no "issue created from what parsed" for it — that signal is rejected
 * per-item (001 T024), not defaulted into a fingerprint with no meaning.
 */
export const signalSchema = z.object({
  // `{ offset: true }` (review finding): plain `.datetime()` rejects a valid RFC 3339 timestamp
  // with a timezone offset (`+02:00`), accepting only a literal `Z` — confirmed empirically.
  observedAt: z.string().datetime({ offset: true }),
  component: z.string(),
  environment: z.string(),
  errorSignature: errorSignatureSchema,
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional().catch(undefined),
  traceId: z.string().optional().catch(undefined),
  deploymentRef: z.string().optional().catch(undefined),
});

export type SignalDto = z.infer<typeof signalSchema>;

/**
 * The outer envelope only — `signals` is checked for shape (an array, within the batch cap) but
 * each item is validated individually downstream (001 T024's `parseSignalBatch`), not by one
 * `z.array(signalSchema)` that would reject the whole batch over a single malformed item. Matches
 * `specs/001-issue-and-evidence/contracts/openapi.yaml`'s `Signal` schema at the per-item level.
 */
export const ingestSignalsRequestSchema = z
  .object({
    signals: z.array(z.unknown()).max(MAX_SIGNAL_BATCH_SIZE),
  })
  .strict();

export type IngestSignalsRequest = z.infer<typeof ingestSignalsRequestSchema>;

export interface RejectedSignal {
  readonly index: number;
  readonly error: string;
}

export interface ParsedSignalBatch {
  readonly valid: readonly SignalDto[];
  readonly rejected: readonly RejectedSignal[];
}

/**
 * Splits a batch into what parsed and what didn't (001 T024, FR-019, quickstart 20) — "nothing
 * dropped silently" means every rejected signal is named in the response (`index` + why), not
 * that malformed input blocks its batch-mates.
 */
export function parseSignalBatch(signals: readonly unknown[]): ParsedSignalBatch {
  const valid: SignalDto[] = [];
  const rejected: RejectedSignal[] = [];
  signals.forEach((raw, index) => {
    const result = signalSchema.safeParse(raw);
    if (result.success) {
      valid.push(result.data);
    } else {
      rejected.push({ index, error: result.error.message });
    }
  });
  return { valid, rejected };
}
