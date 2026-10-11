/**
 * Splits a markdown body into bounded, addressable sections (005 T017, FR-014). A section never
 * spans a heading; a section longer than `MAX_SECTION_CHARS` is cut into consecutive pieces that
 * share one heading path. Offsets are UTF-16 code-unit indexes into the FULL file text, so
 * `text.slice(charStart, charEnd) === content` and an excerpt is addressable without re-parsing.
 *
 * The bound is 4 000 characters (about 1 000 tokens): small enough that one section is one
 * citation-sized excerpt, large enough that ordinary prose is not shredded.
 */
export const MAX_SECTION_CHARS = 4000;

export interface RawSection {
  readonly ordinal: number;
  readonly headingPath: readonly string[];
  readonly content: string;
  readonly charStart: number;
  readonly charEnd: number;
}

const HEADING = /^(#{1,6})[ \t]+(.*)$/;

/**
 * The ATX title: trailing spaces/tabs/`#` stripped by a backwards scan. (A regex `(.+?)[ \t#]*$` is
 * quadratic on a long line of alternating spaces and hashes: a section-resource bound, FR-014.)
 */
function atxTitle(raw: string): string {
  let end = raw.length;
  while (end > 0 && (raw[end - 1] === ' ' || raw[end - 1] === '\t' || raw[end - 1] === '#')) end--;
  return raw.slice(0, end);
}

/** More sections than the caller allows: refuse rather than build an unbounded row set. */
export class TooManySectionsError extends Error {
  readonly code = 'TOO_MANY_SECTIONS';
  constructor(readonly limit: number) {
    super(`TOO_MANY_SECTIONS: more than ${limit} sections in one document version`);
    this.name = 'TooManySectionsError';
  }
}
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

function safeCut(text: string, at: number): number {
  const c = text.charCodeAt(at - 1);
  return c >= 0xd800 && c <= 0xdbff ? at - 1 : at; // do not split a surrogate pair
}

type Fence = { ch: string; len: number } | null;

/** `inCode`: the line is inside a fence or is its opening/closing line, so it is never a heading. */
function fenceTransition(line: string, fence: Fence): { fence: Fence; inCode: boolean } {
  const run = FENCE.exec(line);
  if (fence !== null) {
    // CommonMark: a closing fence is the same character, at least as long, with nothing after it.
    const closes =
      run !== null &&
      run[1]![0] === fence.ch &&
      run[1]!.length >= fence.len &&
      run[2]!.trim() === '';
    return { fence: closes ? null : fence, inCode: true };
  }
  if (run !== null && !(run[1]![0] === '`' && run[2]!.includes('`'))) {
    return { fence: { ch: run[1]![0]!, len: run[1]!.length }, inCode: true };
  }
  return { fence: null, inCode: false };
}

export function splitSections(
  text: string,
  bodyStart: number,
  maxSections = Number.POSITIVE_INFINITY,
): RawSection[] {
  const out: RawSection[] = [];
  const stack: { level: number; title: string }[] = [];
  let path: string[] = [];
  let start = bodyStart;
  let fence: Fence = null;

  const emit = (end: number): void => {
    let from = start;
    while (from < end) {
      let to = Math.min(end, from + MAX_SECTION_CHARS);
      if (to < end) to = safeCut(text, to);
      const content = text.slice(from, to);
      if (content.trim() !== '') {
        if (out.length >= maxSections) throw new TooManySectionsError(maxSections);
        out.push({ ordinal: out.length, headingPath: path, content, charStart: from, charEnd: to });
      }
      from = to;
    }
  };

  let pos = bodyStart;
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    const line = text.slice(pos, nl === -1 ? text.length : nl).replace(/\r$/, '');
    const t = fenceTransition(line, fence);
    fence = t.fence;
    if (!t.inCode) {
      const h = HEADING.exec(line);
      const title = h === null ? '' : atxTitle(h[2]!);
      if (h !== null && title !== '') {
        emit(pos);
        const level = h[1]!.length;
        while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
        stack.push({ level, title });
        path = stack.map((s) => s.title);
        start = pos;
      }
    }
    pos = nl === -1 ? text.length : nl + 1;
  }
  emit(text.length);
  return out;
}
