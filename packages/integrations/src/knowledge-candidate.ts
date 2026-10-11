import { createHash } from 'node:crypto';
import type { UntrustedText } from '@healer/domain-knowledge';

/**
 * What an adapter hands the ingest before it becomes a `knowledge_document` (005 data-model). Every
 * piece of host- or author-written text is `UntrustedText` — a plain string is not assignable — so a
 * commit message, MR description or test name cannot reach a ranking rule, policy predicate or tool
 * argument without a greppable `unwrapUntrusted` (FR-026). Defined here, not in `knowledge`: the
 * `knowledge -> integrations` direction must never exist.
 */
export type CandidateSourceKind =
  'git_history' | 'merge_request' | 'ticket' | 'openapi' | 'test_names';
export type CandidateDocumentClass =
  'design_doc' | 'merge_request' | 'ticket' | 'api_description' | 'test_manifest';

export interface KnowledgeDocumentCandidate {
  readonly sourceKind: CandidateSourceKind;
  readonly documentClass: CandidateDocumentClass;
  /** Identifier minted from structure — only `structuralRef` / `hashRef` can produce one. */
  readonly externalRef: StructuralRef;
  readonly title: UntrustedText;
  readonly body: UntrustedText;
}

/** Code-unit comparison: deterministic, locale-independent. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function byExternalRef(a: { externalRef: string }, b: { externalRef: string }): number {
  return compareStrings(a.externalRef, b.externalRef);
}

declare const structural: unique symbol;
/** A string that passed a structural-shape check (or is a hash). A plain string is not assignable. */
export type StructuralRef = string & { readonly [structural]: true };

export class MalformedCandidateError extends Error {
  constructor(what: string) {
    super(`malformed ${what}`);
    this.name = 'MalformedCandidateError';
  }
}

export function sha256_12(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}

/** Mints a ref from `value` only if it fully matches `shape`; otherwise throws (never echoes it). */
export function structuralRef(what: string, value: string, shape: RegExp): StructuralRef {
  if (!shape.test(value)) throw new MalformedCandidateError(what);
  return value as StructuralRef;
}

/** Wraps an already-composed string made only of structural parts and hex digests. */
export function composeRef(composed: string): StructuralRef {
  return composed as StructuralRef;
}

export const SHA_SHAPE = /^[0-9a-f]{7,64}$/;
