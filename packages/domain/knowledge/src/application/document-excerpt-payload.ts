import { z } from 'zod';
import type { UntrustedText } from '../domain/untrusted-text.js';

/**
 * Bound on the persisted excerpt, in UTF-16 code units (R-11: an excerpt is a citation, not a
 * copy of the document). A placeholder like 001's own excerpt limit, not a measured value.
 */
export const DOCUMENT_EXCERPT_MAX_LENGTH = 2_000;

export type Provenance = 'human_authored' | 'machine_generated' | 'machine_generated_adopted';

export interface Freshness {
  readonly sourceModifiedAt?: string;
  readonly lastSyncedAt?: string;
  readonly lastVerifiedAt?: string;
}

/**
 * The document arm of retrieval-contract.md section 1 `RetrievalResult`, declared locally until
 * T058 builds the result union and adopts (moves) this type. There is deliberately no
 * `ObservationResult` arm: an observation has no version to pin and no freshness to snapshot, so a
 * `document_excerpt` about one is unrepresentable (the `kind` literal), not refused at runtime.
 */
export interface DocumentResult {
  readonly kind: 'document';
  readonly tier: number;
  readonly ruleId: string;
  readonly ruleSetVersion: number;
  readonly content: UntrustedText;
  readonly documentVersionId: string;
  readonly sectionId: string;
  readonly matchedSpan: readonly [number, number];
  readonly provenance: Provenance;
  readonly freshness: Freshness;
  readonly originRef: string;
  readonly detached: boolean;
}

const iso = z.string().max(40).datetime({ offset: true });
const ordinal = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const MAX_TIER = 5;
export const MAX_RULE_ID_LENGTH = 128;
export const MAX_ORIGIN_REF_LENGTH = 1024;

/**
 * `Evidence.payload` for `type: 'document_excerpt'`. 001's boundary contract has no kind for it
 * (a document never crosses the runner boundary), so the schema lives with its producer. Strict:
 * no free-form fields, and no excerpt text (that is `Evidence.excerpt`, bounded).
 */
export const documentExcerptPayloadSchema = z
  .object({
    kind: z.literal('document_excerpt'),
    documentVersionId: z.string().uuid(),
    sectionId: z.string().uuid(),
    matchedSpan: z.tuple([ordinal, ordinal]).refine(([a, b]) => a <= b, 'inverted span'),
    /** Where in the section the persisted excerpt begins (it is a window around the span). */
    excerptStart: ordinal,
    tier: z.number().int().min(1).max(MAX_TIER),
    ruleId: z.string().min(1).max(MAX_RULE_ID_LENGTH),
    ruleSetVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    provenance: z.enum(['human_authored', 'machine_generated', 'machine_generated_adopted']),
    freshness: z
      .object({
        sourceModifiedAt: iso.optional(),
        lastSyncedAt: iso.optional(),
        lastVerifiedAt: iso.optional(),
      })
      .strict(),
    originRef: z.string().min(1).max(MAX_ORIGIN_REF_LENGTH),
    detached: z.boolean(),
    recordedAt: iso,
  })
  .strict();

export type DocumentExcerptPayload = z.infer<typeof documentExcerptPayloadSchema>;

/** Snapshot at the moment of use: copies every field, so later mutation of the source cannot reach it. */
export function toDocumentExcerptPayload(
  r: DocumentResult,
  at: Date,
  excerptStart: number,
): DocumentExcerptPayload {
  return documentExcerptPayloadSchema.parse({
    kind: 'document_excerpt',
    documentVersionId: r.documentVersionId,
    sectionId: r.sectionId,
    matchedSpan: [r.matchedSpan[0], r.matchedSpan[1]],
    excerptStart,
    tier: r.tier,
    ruleId: r.ruleId,
    ruleSetVersion: r.ruleSetVersion,
    provenance: r.provenance,
    freshness: { ...r.freshness },
    originRef: r.originRef,
    detached: r.detached,
    recordedAt: at.toISOString(),
  });
}

/**
 * The window of `text` persisted as the excerpt: `DOCUMENT_EXCERPT_MAX_LENGTH` units centred on the
 * matched span (a head+tail extract could drop the very match being cited). A span longer than the
 * bound keeps its start. Boundaries never split a surrogate pair.
 */
export function excerptAround(
  text: string,
  span: readonly [number, number],
): { readonly excerpt: string; readonly start: number; readonly truncated: boolean } {
  const cap = DOCUMENT_EXCERPT_MAX_LENGTH;
  if (text.length <= cap) return { excerpt: text, start: 0, truncated: false };
  const mid = Math.floor((span[0] + span[1]) / 2);
  const wanted = span[1] - span[0] >= cap ? span[0] : mid - Math.floor(cap / 2);
  let start = Math.min(Math.max(0, wanted), text.length - cap);
  let end = start + cap;
  const isLow = (i: number) => (text.charCodeAt(i) & 0xfc00) === 0xdc00;
  if (start > 0 && isLow(start)) start += 1;
  if (end < text.length && isLow(end)) end -= 1;
  return { excerpt: text.slice(start, end), start, truncated: true };
}
