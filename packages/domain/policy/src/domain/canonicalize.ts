// Shared by `policy-ruleset.ts` (ruleset digest) and `proposal-digest.ts` (proposal digest) —
// factored out after review found the ruleset digest computation duplicating this exact logic
// but only at the top level, missing the nested `predicates` array's own objects.
//
// Recursively sorts object keys (arrays keep their given order) so two structurally identical
// values hash identically regardless of the object-literal key order a caller happened to write,
// or the key order a `jsonb` column returns after a round trip through Postgres — `jsonb` does
// not preserve insertion order, so anything that reads a rule back from the database and
// republishes it unchanged must still hash identically to what was originally published, or the
// "identical content is a no-op" guarantee (R-01) silently breaks for exactly that path.
//
// `Date` is special-cased ahead of the generic object branch: a `Date` is `typeof === 'object'`
// but has no own enumerable properties, so treating it as a plain record would silently hash it
// as `{}` instead of its value.
export function canonicalize(value: unknown): unknown {
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
