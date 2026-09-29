import { createHash } from 'node:crypto';
import type { DecisionInput } from './decision-input.js';

// T021: `policy_decision.proposal_digest` — "canonical hash of the DecisionInput; a decision is
// valid for this digest only" (data-model.md). Recursively sorts object keys so two structurally
// identical `DecisionInput`s hash identically regardless of the key order a caller happened to
// build the object literal in — the same reasoning `tool-call-digest.ts`'s own `canonicalize`
// applies, duplicated locally rather than imported (that package is unrelated to this one; this
// package already mirrors small shared facts locally rather than taking a cross-domain-package
// dependency, per `audit-entry.ts`'s own convention). `Date` is special-cased ahead of the
// generic object branch: a `Date` is `typeof === 'object'` but has no own enumerable properties,
// so treating it as a plain record would silently hash `evaluatedAt` as `{}`.
function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => [key, canonicalize(v)]),
    );
  }
  return value;
}

export function computeProposalDigest(input: DecisionInput): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(input))).digest('hex');
}
