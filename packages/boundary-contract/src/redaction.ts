/**
 * Redaction (012 T047, R-05, FR-023). "Unredactable" has exactly two outcomes, not three: an
 * item is cleared to cross, or it is withheld with a recorded `collection_gap` — there is no
 * `truncated` state. A shape with only these two variants makes "send it best-effort, truncated"
 * unrepresentable rather than merely discouraged (docs/patterns.md).
 *
 * The actual classification policy — what makes a given excerpt "safe" — is not decided here.
 * No spec has defined it yet (003/005 own the knowledge and context redaction rules); this
 * module is the mechanism a real policy plugs into, matching every other Phase-6 gate that has a
 * working shape today and real content later.
 */
import type { CollectionGap } from './outbound-buffer.js';

export type RedactionOutcome<T> =
  | { readonly status: 'clear'; readonly value: T }
  | { readonly status: 'withheld'; readonly gap: CollectionGap };

export type RedactionPolicy<T> = (candidate: T) => boolean;

export function redact<T>(
  candidate: T,
  isSafe: RedactionPolicy<T>,
  describe: (candidate: T) => string,
): RedactionOutcome<T> {
  if (isSafe(candidate)) return { status: 'clear', value: candidate };
  return {
    status: 'withheld',
    gap: {
      kind: 'collection_gap',
      what: describe(candidate),
      why: 'redactor could not establish the item was safe to transmit',
      withheldByRedaction: true,
    },
  };
}
