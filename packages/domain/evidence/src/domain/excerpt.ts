import type { EvidenceExcerpt } from './types.js';

/**
 * Bounds a captured excerpt at record time (R-05, FR-011): beyond `maxLength`, a head-and-tail
 * extract replaces the full text and `excerptTruncated` is marked — never done later, since by
 * then the oversized row is already written. `maxLength` is configuration (spec.md assumptions),
 * not a constant here: the caller supplies the configured value rather than this function
 * choosing one.
 */
export function boundExcerpt(raw: string | null, maxLength: number): EvidenceExcerpt {
  if (maxLength <= 0) throw new Error('boundExcerpt requires a positive maxLength');
  if (raw === null) return { excerpt: null, excerptTruncated: false };

  // Slice by code point, not by UTF-16 code unit — `raw.slice()` on text containing a surrogate
  // pair (e.g. an emoji in a captured log line) can cut it in half, leaving a lone surrogate that
  // later fails to round-trip through Postgres/JSON as valid UTF-8.
  const codePoints = Array.from(raw);
  if (codePoints.length <= maxLength) return { excerpt: raw, excerptTruncated: false };

  const headLength = Math.ceil(maxLength / 2);
  const tailLength = maxLength - headLength;
  const head = codePoints.slice(0, headLength).join('');
  const tail = tailLength > 0 ? codePoints.slice(codePoints.length - tailLength).join('') : '';
  return { excerpt: `${head}${tail}`, excerptTruncated: true };
}
