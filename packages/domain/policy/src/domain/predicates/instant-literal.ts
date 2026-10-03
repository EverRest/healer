// Fixes a timezone-dependent parsing bug (002 batch 9 round 3, QUESTIONS.md): an instant
// predicate's literal (e.g. `evaluatedAt before '2026-01-01T00:00:00'`) was parsed with plain
// `new Date(string)`, which treats an offset-less string as *local* time — the same rule
// evaluates differently depending on the server's timezone, directly violating FR-002's
// determinism. Requires an explicit UTC/offset suffix (`Z` or `+HH:mm`/`-HH:mm`), the same
// `datetime({ offset: true })` contract `decision-input.ts` already enforces for `evaluatedAt`
// itself — one authority for "what counts as a real instant literal" in this package, not two.
const ISO_INSTANT_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Returns the parsed UTC timestamp, or `NaN` for anything that isn't a full ISO-8601
 *  datetime carrying an explicit offset — never falls back to locale/timezone-dependent
 *  parsing. */
export function parseInstantLiteral(value: string): number {
  if (!ISO_INSTANT_WITH_OFFSET.test(value)) return NaN;
  return new Date(value).getTime();
}
