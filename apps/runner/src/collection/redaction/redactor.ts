import { createHmac } from 'node:crypto';
import { EXCERPT_MAX_CHARS, REDACTION_RULESETS, type DetectorKey } from '@healer/boundary-contract';
import {
  DETECTORS,
  carriesNoSignal,
  replaceNumericRuns,
  type DetectorContext,
} from './detectors.js';

/** How much of a raw record is ever examined. A 40 MB payload costs a bounded scan, and what lies
 *  past the bound never crosses (FR-013) — it is not redacted, it is not read. */
export const CAPTURE_MAX_CHARS = 8192;

/** The detectors safe to run on a structural field: no free-text or digit-run rules, so a commit
 *  sha or a deployment id is not mistaken for an identifier. */
const SHAPE_DETECTORS: readonly DetectorKey[] = [
  'private_key_block',
  'payment_instrument',
  'national_identifier',
  'connection_string',
  'bearer_token',
  'email_address',
];

/**
 * What is screened across a whole source record. Not the numeric-run rule: a long digit run welded
 * to letters (`123456Z`, a trace id) says nothing about a record that merely contains one — that
 * rule judges the excerpt only.
 */
const SCREEN_DETECTORS: readonly DetectorKey[] = [
  'private_key_block',
  'payment_instrument',
  'national_identifier',
  'connection_string',
];

/** Replace-only detectors for structural fields — they never withhold, so a sha is not mistaken for an id. */
const SHAPE_REPLACERS: readonly DetectorKey[] = ['uuid_in_message_position', 'ip_address'];

export type ExcerptOutcome =
  | { readonly status: 'withheld'; readonly detector: DetectorKey }
  | {
      readonly status: 'clear';
      /** Absent when free text forced the whole excerpt to be dropped — never partially sent. */
      readonly text: string | undefined;
      readonly truncated: boolean;
      readonly redactionDominated: boolean;
    };

export type ScrubOutcome<T> =
  | { readonly status: 'clear'; readonly value: T }
  | { readonly status: 'withheld'; readonly detector: DetectorKey };

export interface RedactorOptions {
  readonly tenantId: string;
  /** Secret behind the stable per-tenant email pseudonym; never leaves the runner. */
  readonly pseudonymKey: Buffer;
}

function cutAtWord(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  const head = text.slice(0, max + 1);
  const at = head.search(/\s\S*$/);
  return { text: head.slice(0, at > 0 ? at : max).trimEnd(), cut: true };
}

/**
 * Applies one published ruleset version (003 T018, FR-008). There is no `truncated` state: an item
 * is cleared by replacement, or withheld — and text no detector structured is dropped, not sent
 * best-effort (012 R-05).
 */
export class Redactor {
  private constructor(
    private readonly detectors: readonly DetectorKey[],
    private readonly options: RedactorOptions,
  ) {}

  /** `undefined` for a version this image does not know — the caller withholds everything. */
  static forVersion(version: number, options: RedactorOptions): Redactor | undefined {
    const definition = REDACTION_RULESETS[version];
    return definition === undefined ? undefined : new Redactor(definition.detectors, options);
  }

  private context(): DetectorContext {
    const { tenantId, pseudonymKey } = this.options;
    return {
      pseudonym: (value) =>
        createHmac('sha256', pseudonymKey)
          .update(`${tenantId}\0${value}`)
          .digest('hex')
          .slice(0, 8),
      uuids: new Map(),
    };
  }

  private run(
    text: string,
    detectors: readonly DetectorKey[],
  ): { text: string; failed?: DetectorKey; freeText: boolean } {
    const ctx = this.context();
    // NFKC: fullwidth digits and look-alike forms are read as what they are, not skipped.
    let current = text.normalize('NFKC');
    for (const key of detectors) {
      const out = DETECTORS[key](current, ctx);
      if (out.withhold) {
        if (key === 'free_text_span') return { text: current, freeText: true };
        return { text: current, failed: key, freeText: false };
      }
      current = out.text;
    }
    return { text: current, freeText: false };
  }

  /** The first whole-item detector that fires on this record, if any — nothing is rewritten. */
  screen(record: string): DetectorKey | undefined {
    const detectors = this.detectors.filter((k) => SCREEN_DETECTORS.includes(k));
    return this.run(cutAtWord(record, CAPTURE_MAX_CHARS).text, detectors).failed;
  }

  clearExcerpt(raw: string): ExcerptOutcome {
    // A literal `<` is rewritten to a non-ASCII bracket before any detector runs: the only
    // placeholders in the text are then ours, and one the input forged is free text, so the
    // excerpt is dropped rather than a forged placeholder carrying words through.
    const captured = cutAtWord(raw.replace(/</g, '\u2039'), CAPTURE_MAX_CHARS);
    const result = this.run(captured.text, this.detectors);
    if (result.failed !== undefined) return { status: 'withheld', detector: result.failed };
    if (result.freeText) {
      return {
        status: 'clear',
        text: undefined,
        truncated: captured.cut,
        redactionDominated: true,
      };
    }
    const bounded = cutAtWord(result.text, EXCERPT_MAX_CHARS);
    return {
      status: 'clear',
      text: bounded.text,
      truncated: captured.cut || bounded.cut,
      redactionDominated: carriesNoSignal(bounded.text),
    };
  }

  /** Scrubs every string leaf of a structural shape (everything but `kind`). */
  scrubShape<T>(value: T): ScrubOutcome<T> {
    let failed: DetectorKey | undefined;
    const walk = (node: unknown, key?: string): unknown => {
      if (typeof node === 'string') {
        if (key === 'kind') return node;
        // A handle is a person: it crosses only as a stable per-tenant pseudonym, so authorship
        // can still be correlated without the name.
        if (key === 'authorHandle') return `h_${this.context().pseudonym(node.toLowerCase())}`;
        const r = this.run(node, SHAPE_DETECTORS);
        failed ??= r.failed;
        return replaceNumericRuns(this.run(r.text, SHAPE_REPLACERS).text);
      }
      if (Array.isArray(node)) return node.map((n) => walk(n));
      if (node !== null && typeof node === 'object') {
        return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v, k)]));
      }
      return node;
    };
    const scrubbed = walk(value) as T;
    return failed === undefined
      ? { status: 'clear', value: scrubbed }
      : { status: 'withheld', detector: failed };
  }
}
