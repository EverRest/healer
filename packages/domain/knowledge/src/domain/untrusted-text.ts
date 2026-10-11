import { inspect } from 'node:util';

/**
 * The only type document content is carried in (005 T015, FR-026, R-11): text is data, never an
 * input to a ranking rule, a policy predicate, a tool argument or an autonomy decision.
 *
 * By construction, not by convention:
 *  - the class is not exported, so `new` is impossible outside this file; `untrustedText()` is the
 *    one named factory, and the `#raw` field makes the type nominal (a plain string is not
 *    assignable, an `UntrustedText` is not assignable to `string`);
 *  - every implicit coercion (`String(x)`, template, `+`, `JSON.stringify`, `util.inspect`)
 *    yields a redacting marker, never the content;
 *  - the content leaves only through `unwrapUntrusted(text, reason)`, which is greppable, takes a
 *    closed reason, and whose callers are pinned by `untrusted-text.test.ts` (the reader for this
 *    guarantee: it fails when a file outside its allowlist calls it).
 */
const REDACTED = '[UntrustedText redacted]';

// Assigned once, in the static block below; the only reader of `#raw`. A module-local binding, so
// nothing reachable from an instance (prototype, constructor) exposes it.
let readRaw: (text: Untrusted) => string;

class Untrusted {
  readonly #raw: string;

  static {
    readRaw = (text) => text.#raw;
  }

  constructor(raw: string) {
    this.#raw = raw;
  }

  toString(): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  toJSON(): { readonly untrusted: true; readonly length: number } {
    return { untrusted: true, length: this.#raw.length };
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

export type UntrustedText = Untrusted;

/** Closed list of reasons content may be taken out (one authority; extend here, defend in review). */
export const UNWRAP_REASONS = Object.freeze(['display', 'indexing', 'evidence'] as const);
export type UnwrapReason = (typeof UNWRAP_REASONS)[number];

export function untrustedText(raw: string): UntrustedText {
  return new Untrusted(raw);
}

export function unwrapUntrusted(text: UntrustedText, reason: UnwrapReason): string {
  if (!UNWRAP_REASONS.includes(reason)) {
    throw new Error('unwrapUntrusted requires a declared reason');
  }
  return readRaw(text);
}
