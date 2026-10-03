import { z } from 'zod';
import { COLLECTOR_KEYS, GAP_REASON_CODES, ITEM_CLASSES, SOURCE_STATUSES } from './collection.js';
import { RunnerEvidence } from './shapes.js';

/**
 * The result batch (003 T006–T008, contracts/collection-plan.md): one batch per pass, validated
 * twice against this one definition — `validateResultBatchEgress` on the runner before anything is
 * sent, `validateResultBatchIngress` in the control plane before any domain write (012 FR-022,
 * R-02). Two executions, one schema; there is no second copy to drift.
 */

const isoTimestamp = z.string().datetime({ offset: true });

/**
 * The bound on a crossing excerpt. 001 FR-011 bounds the *stored* size; this bounds what may be
 * *sent* — a bounded, redacted excerpt crosses, an unprocessed body never does (spec assumptions).
 * Equal to the cap on a `tool_output_summary` field, so no declared string field is longer than
 * another.
 */
export const EXCERPT_MAX_CHARS = 500;

const excerpt = z
  .object({ text: z.string().max(EXCERPT_MAX_CHARS), truncated: z.boolean() })
  .strict();

/**
 * One collected fact: a member of 012's closed shape set plus the envelope facts the evidence
 * record needs (observed time, producing collector, the ruleset version that cleared it). The
 * excerpt is the one bounded text field and it rides beside the shape, never inside it — the
 * shapes stay exactly the closed list (R-03).
 */
export const CollectionResultItem = z
  .object({
    evidence: RunnerEvidence,
    collectorKey: z.enum(COLLECTOR_KEYS),
    observedAt: isoTimestamp,
    excerpt: excerpt.optional(),
    /** The excerpt survived redaction but carries no signal — look locally (R-08). */
    redactionDominated: z.boolean(),
    redactionRulesetVersion: z.number().int().positive(),
    /** Where the original lives, inside the customer's plane — set when the item was reduced (R-08). */
    localRef: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((item, ctx) => {
    const e = item.evidence;
    if (e.kind !== 'collection_gap') return;
    // A gap in a collection batch is structural: `what` names a collector or item class and `why`
    // a reason code, so prose — where a raw line would ride — has nowhere to go.
    const what: readonly string[] = [...COLLECTOR_KEYS, ...ITEM_CLASSES];
    const why: readonly string[] = GAP_REASON_CODES;
    if (!what.includes(e.what) || !why.includes(e.why)) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidence', 'what'],
        message: 'a collection gap names a collector or item class and a closed reason code',
      });
    }
  });

const sourceOutcome = z
  .object({
    collectorKey: z.enum(COLLECTOR_KEYS),
    status: z.enum(SOURCE_STATUSES),
    reasonCode: z.enum(GAP_REASON_CODES).optional(),
    itemCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
    durationMs: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((outcome, ctx) => {
    // Only `collected` has nothing to explain; every other status names its closed reason, which is
    // what a downstream step branches on (credentials revoked is not the same as empty — R-07).
    if ((outcome.status === 'collected') !== (outcome.reasonCode === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['reasonCode'],
        message: 'a reason code accompanies every status except collected',
      });
    }
  });

export const CollectionResultBatch = z
  .object({
    passId: z.string().uuid(),
    planDigest: z.string().min(1),
    contractVersion: z.number().int().positive(),
    runnerImageVersion: z.string().min(1),
    collectedAt: isoTimestamp,
    sourceOutcomes: z.array(sourceOutcome),
    items: z.array(CollectionResultItem),
  })
  .strict();

export type CollectionResultBatch = z.infer<typeof CollectionResultBatch>;
export type ResultItem = z.infer<typeof CollectionResultItem>;
export type SourceOutcome = z.infer<typeof sourceOutcome>;

export interface BatchValidationResult {
  readonly ok: boolean;
  readonly batch?: CollectionResultBatch;
  /**
   * Where the payload failed, as `path#code` strings — never a received value and never a key name
   * the sender chose (R-13: a rejected payload is the one most likely to hold what must not be
   * stored, so the diagnostics derived from it hold none of it either).
   */
  readonly schemaErrorPaths?: readonly string[];
}

const MAX_REPORTED_PATHS = 50;
const SAFE_SEGMENT = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/**
 * A path segment is an array index or a declared field name. A record key (a `tool_output_summary`
 * field name) is sender-chosen text, so anything not shaped like an identifier is replaced.
 */
function safePath(path: readonly (string | number)[]): string {
  return path
    .map((segment, at) => {
      if (typeof segment === 'number') return String(segment);
      // The only record in a batch is a `tool_output_summary`'s `fields`: whatever is keyed under
      // it is the sender's own text, even when it looks like an identifier.
      if (path[at - 1] === 'fields') return '<key>';
      return SAFE_SEGMENT.test(segment) ? segment : '<key>';
    })
    .join('.');
}

function validate(payload: unknown): BatchValidationResult {
  const result = CollectionResultBatch.safeParse(payload);
  if (result.success) return { ok: true, batch: result.data };
  const paths = new Set(result.error.issues.map((i) => `${safePath(i.path)}#${i.code}`));
  return { ok: false, schemaErrorPaths: [...paths].slice(0, MAX_REPORTED_PATHS) };
}

/** Runner-side: a batch failing this is never sent. */
export function validateResultBatchEgress(payload: unknown): BatchValidationResult {
  return validate(payload);
}

/** Control-plane-side: independent of egress — the sender may be an older image or not ours at all. */
export function validateResultBatchIngress(payload: unknown): BatchValidationResult {
  return validate(payload);
}
