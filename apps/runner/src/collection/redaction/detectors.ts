import type { DetectorKey } from '@healer/boundary-contract';
import { TEMPLATE_VOCABULARY, UPPERCASE_ALLOWLIST } from './vocabulary.js';

/**
 * The detector implementations of redaction ruleset v1 (003 T018, R-07a). `DETECTORS` is a
 * `Record<DetectorKey, …>`: the published ruleset cannot name a detector this image does not
 * implement, and an implemented detector the ruleset does not name is a type error the other way.
 *
 * A detector either rewrites the text (clears by replacement) or says `withhold` — the item cannot
 * be handled at all and fails closed. There is no third outcome that sends something truncated.
 */
export interface DetectorOutcome {
  readonly text: string;
  readonly withhold: boolean;
}

export interface DetectorContext {
  readonly pseudonym: (value: string) => string;
  /** Equal uuids in one text share one positional placeholder. */
  readonly uuids: Map<string, number>;
}

export type Detector = (text: string, ctx: DetectorContext) => DetectorOutcome;

const keep = (text: string): DetectorOutcome => ({ text, withhold: false });
const withhold = (text: string): DetectorOutcome => ({ text, withhold: true });

/** Every placeholder this module can emit — and nothing else counts as one (a forged `<name:John>` is text). */
const PLACEHOLDER =
  /<(?:email:[0-9a-f]{8}|uuid:\d+|num:\d+|ip:\d{1,3}\.\d{1,3}\.\d{1,3}\.x|ipv6:[0-9a-f:]+x|conn:[a-z][a-z0-9+.-]*:\/\/[\w.:[\]-]*(?:\/[\w.-]*)?|removed)>/g;

export function stripPlaceholders(text: string): string {
  return text.replace(PLACEHOLDER, ' ');
}

/** Runs `fn` over the text between placeholders only — a placeholder is output, not input. */
function outsidePlaceholders(text: string, fn: (segment: string) => string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(PLACEHOLDER)) {
    out += fn(text.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + fn(text.slice(last));
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const privateKeyBlock: Detector = (text) =>
  /-----BEGIN [A-Z0-9 ]+-----/.test(text) ? withhold(text) : keep(text);

/** Every 13–19 digit window of a digit run, so a card inside a longer number is still a card. */
function hasLuhnWindow(digits: string): boolean {
  for (let len = 13; len <= 19; len += 1) {
    for (let at = 0; at + len <= digits.length; at += 1) {
      if (luhnValid(digits.slice(at, at + len))) return true;
    }
  }
  return false;
}

const paymentInstrument: Detector = (text) => {
  for (const m of text.matchAll(/(?<![\w-])\d(?:[ .\/-]?\d){12,40}(?![\w-])/g)) {
    if (hasLuhnWindow(m[0].replace(/\D/g, ''))) return withhold(text);
  }
  return keep(text);
};

const nationalIdentifier: Detector = (text) =>
  /(?<![\d-])\d{3}-\d{2}-\d{4}(?![\d-])/.test(text) ||
  /\b[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/.test(text)
    ? withhold(text)
    : keep(text);

const connectionString: Detector = (text) => {
  const cleared = text.replace(
    /\b([a-z][a-z0-9+.-]*):\/\/[^\s/@:]+(?::[^\s/@]*)?@([\w.:[\]-]+)(\/[\w.-]*)?/gi,
    (_m, scheme: string, host: string, db: string | undefined) =>
      `<conn:${scheme}://${host}${db ?? ''}>`,
  );
  // A URL that still has an `@` in its authority is one whose credential segment we could not
  // locate: fail closed rather than send a string that may still carry it.
  return /[a-z][a-z0-9+.-]*:\/\/[^\s<]*@/i.test(cleared) ? withhold(text) : keep(cleared);
};

const KEYED_SECRET =
  /\b([\w.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|authorization)[\w.-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi;

const bearerToken: Detector = (text) =>
  keep(
    text
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, '<removed>')
      .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, '<removed>')
      .replace(
        /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,})\b/g,
        '<removed>',
      )
      .replace(KEYED_SECRET, '$1$2<removed>'),
  );

const emailAddress: Detector = (text, ctx) =>
  keep(
    text.replace(
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
      (email) => `<email:${ctx.pseudonym(email.toLowerCase())}>`,
    ),
  );

const uuidInMessagePosition: Detector = (text, ctx) =>
  keep(
    text.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, (id) => {
      const key = id.toLowerCase();
      if (!ctx.uuids.has(key)) ctx.uuids.set(key, ctx.uuids.size + 1);
      return `<uuid:${ctx.uuids.get(key)}>`;
    }),
  );

const ipAddress: Detector = (text) =>
  keep(
    text
      .replace(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?!\d|\.\d)/g, (ip) => {
        const octets = ip.split('.').map(Number);
        return octets.every((o) => o <= 255) ? `<ip:${octets.slice(0, 3).join('.')}.x>` : ip;
      })
      // IPv6, including `::` compression: at least three colons or a `::` (so a clock time is not one)
      .replace(/(?<![\w:])[0-9a-f:]{3,39}(?![\w:])/gi, (m) => {
        const groups = m.split(':');
        const isV6 = m.includes('::') || groups.length >= 4;
        if (!isV6 || !groups.every((g) => /^[0-9a-f]{0,4}$/i.test(g))) return m;
        return `<ipv6:${groups.filter(Boolean).slice(0, 3).join(':').toLowerCase()}:x>`;
      }),
  );

const UNCLASSIFIABLE_RUN = /(?<=[A-Za-z_])\d{6,}|\d{6,}(?=[A-Za-z_])/;

/** Digit runs and phone shapes → a length-preserving placeholder. Never withholds. */
export const replaceNumericRuns = (text: string): string =>
  outsidePlaceholders(text, (segment) =>
    segment
      .replace(/(?<![\w<:])\d{6,}(?![\w>])/g, (run) => `<num:${run.length}>`)
      .replace(
        /(?<![\w<:])\(\d{3}\)[\s.-]?\d{3}[\s.-]\d{4}(?![\w>])/g,
        (m) => `<num:${m.replace(/\D/g, '').length}>`,
      )
      .replace(/(?<![\w<:.-])\d{3}-\d{4}(?![\w>-])/g, '<num:7>')
      // phone-shaped groups: 8+ digits across separators
      .replace(
        /(?<![\w<:])\+?\d{1,3}[\s.-]\(?\d{2,4}\)?[\s.-]\d{3,4}(?:[\s.-]\d{2,4})?(?![\w>])/g,
        (m) => `<num:${m.replace(/\D/g, '').length}>`,
      ),
  );

const numericIdentifierRun: Detector = (text) => {
  // A long digit run welded to letters is an identifier whose boundary we cannot classify.
  if (
    stripPlaceholders(text)
      .split(/\s+/)
      .some((t) => UNCLASSIFIABLE_RUN.test(t))
  ) {
    return withhold(text);
  }
  return keep(replaceNumericRuns(text));
};

const trimPunctuation = (t: string): string => t.replace(/^[^A-Za-z0-9_$]+|[^A-Za-z0-9_$]+$/g, '');
const SOURCE_PATH =
  /^(?:\.{0,2}\/)?(?:src|lib|app|apps|packages|dist|test|tests|internal|cmd|pkg|services|server|client)\/[\w@$.+/-]*\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|rb|rs|cs|php)(?::\d+){0,2}$/;

function isStructuralToken(token: string): boolean {
  if (SOURCE_PATH.test(token) || /^\d{1,5}$/.test(token)) return true;
  return token.split(/[^A-Za-z0-9_$]+/).every((part) => {
    if (part === '' || /^\d{1,5}$/.test(part)) return true;
    if (UPPERCASE_ALLOWLIST.has(part)) return true;
    return part
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[\s_$-]+/)
      .every((word) => word === '' || TEMPLATE_VOCABULARY.has(word.toLowerCase()));
  });
}

/**
 * Default-deny: any token outside the template vocabulary and the structural forms is free text.
 * A token with a non-ASCII character is free text outright — stripping punctuation must not turn
 * a name in another script into "nothing".
 */
export function hasFreeText(text: string): boolean {
  return stripPlaceholders(text)
    .split(/\s+/)
    .some((raw) => {
      if (/[^\x00-\x7F]/.test(raw)) return true;
      const token = trimPunctuation(raw);
      return token !== '' && !isStructuralToken(token);
    });
}

/** True when nothing but placeholders and punctuation is left — redaction dominated (R-08). */
export function carriesNoSignal(text: string): boolean {
  return stripPlaceholders(text)
    .split(/\s+/)
    .map(trimPunctuation)
    .every((token) => token === '');
}

const freeTextSpan: Detector = (text) => (hasFreeText(text) ? withhold(text) : keep(text));

export const DETECTORS: Readonly<Record<DetectorKey, Detector>> = {
  private_key_block: privateKeyBlock,
  payment_instrument: paymentInstrument,
  national_identifier: nationalIdentifier,
  connection_string: connectionString,
  bearer_token: bearerToken,
  email_address: emailAddress,
  uuid_in_message_position: uuidInMessagePosition,
  ip_address: ipAddress,
  numeric_identifier_run: numericIdentifierRun,
  free_text_span: freeTextSpan,
};

/**
 * A structural name (a span name, a service edge): numeric ids, uuids and ips are replaced first —
 * they are parameters, not words — and what is left must be template vocabulary. Anything else is
 * a name someone chose, and the record is withheld.
 */
export function isStructuralName(name: string): boolean {
  const ctx: DetectorContext = { pseudonym: () => '', uuids: new Map() };
  let text = name;
  for (const key of ['uuid_in_message_position', 'ip_address'] as const) {
    text = DETECTORS[key](text, ctx).text;
  }
  text = replaceNumericRuns(text).replace(/->/g, ' ').replace(/[{}]/g, ' ');
  return !hasFreeText(text);
}
