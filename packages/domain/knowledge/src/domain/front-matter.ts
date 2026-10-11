import { parseDocument } from 'yaml';
import { z } from 'zod';

/**
 * Repository-markdown front matter (005 T017, ADR 0017, retrieval-contract §4). The only typed
 * channel of a document: the body is prose and is never parsed for values (R-08, R-11).
 *
 * Every failure is the one named error, `FRONT_MATTER_INVALID`: a partially parsed expectation is
 * worse than none, so there is no lenient path. Unknown keys are rejected (strict), which also
 * means a file that claims its own `author`/`modified`/`sourceModifiedAt` fails rather than being
 * half-believed — authorship and freshness come from the commit (T020).
 */
export const FRONT_MATTER_INVALID = 'FRONT_MATTER_INVALID';
/** Checked on the raw block BEFORE parsing (ADR 0017). */
export const FRONT_MATTER_MAX_BYTES = 64 * 1024;

/** The one broken rule, so a caller (and a test) can name the cause without parsing a message. */
export type FrontMatterErrorKind =
  | 'missing'
  | 'unterminated'
  | 'size'
  | 'tab_indent'
  | 'duplicate_key'
  | 'unresolved_tag'
  | 'alias_limit'
  | 'syntax'
  | 'schema'
  | 'duration';

export class FrontMatterInvalidError extends Error {
  readonly code = FRONT_MATTER_INVALID;
  constructor(
    readonly kind: FrontMatterErrorKind,
    readonly reason: string,
    readonly line?: number,
    readonly column?: number,
    options?: { cause?: unknown },
  ) {
    super(
      `${FRONT_MATTER_INVALID}: ${reason}${line === undefined ? '' : ` (line ${line}, column ${column ?? 0})`}`,
      options,
    );
    this.name = 'FrontMatterInvalidError';
  }

  /** A `doc.toJS()` failure: only yaml's alias-limit error is an alias error; anything else keeps its cause. */
  static fromConversion(cause: unknown): FrontMatterInvalidError {
    const alias = cause instanceof ReferenceError && /alias/i.test(cause.message);
    return new FrontMatterInvalidError(
      alias ? 'alias_limit' : 'syntax',
      alias ? 'alias expansion limit exceeded' : 'the front matter could not be converted',
      undefined,
      undefined,
      { cause },
    );
  }
}

const DURATION_UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
/** Stated ceiling for a duration constraint: 366 days. Zero and leading zeros are not durations. */
export const MAX_DURATION_MS = 366 * DURATION_UNIT_MS.d;

/** `15s` -> 15000. Pure; `null` unless `<1-9 digits, no leading zero><ms|s|m|h|d>` within the ceiling. */
export function parseDurationMs(raw: string): number | null {
  const m = /^([1-9]\d{0,8})(ms|s|m|h|d)$/.exec(raw);
  if (m === null) return null;
  const ms = Number(m[1]) * DURATION_UNIT_MS[m[2] as keyof typeof DURATION_UNIT_MS];
  return Number.isSafeInteger(ms) && ms <= MAX_DURATION_MS ? ms : null;
}

const constraintValue = z.discriminatedUnion('type', [
  z.object({ type: z.literal('int'), value: z.number().int().safe() }).strict(),
  z.object({ type: z.literal('decimal'), value: z.number().finite() }).strict(),
  z.object({ type: z.literal('bool'), value: z.boolean() }).strict(),
  z.object({ type: z.literal('string'), value: z.string().max(1000) }).strict(),
  z.object({ type: z.literal('duration'), value: z.string() }).strict(),
  z
    .object({ type: z.literal('enum'), value: z.string(), allowed: z.array(z.string()).min(1) })
    .strict(),
]);

const frontMatterSchema = z
  .object({
    feature: z.string().min(1).max(200),
    component: z.string().min(1).max(200),
    expected_behaviors: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
            description: z.string().min(1).max(4000),
          })
          .strict(),
      )
      .default([]),
    constraints: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), constraintValue).default({}),
  })
  .strict()
  .superRefine((fm, ctx) => {
    const seen = new Set<string>();
    fm.expected_behaviors.forEach((e, i) => {
      if (seen.has(e.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['expected_behaviors', i, 'id'],
          message: 'duplicate expected_behaviors id',
        });
      }
      seen.add(e.id);
    });
  });

export type ConstraintValueType = 'int' | 'decimal' | 'bool' | 'duration' | 'string' | 'enum';
export interface ParsedConstraint {
  readonly name: string;
  readonly valueType: ConstraintValueType;
  readonly valueJson: unknown;
}
export interface ParsedFrontMatter {
  readonly feature: string;
  readonly component: string;
  readonly expectedBehaviors: readonly { readonly id: string; readonly description: string }[];
  readonly constraints: readonly ParsedConstraint[];
}

/**
 * Locates the `---` fenced block; returns the YAML text and the offset where the body starts. A
 * leading UTF-8 BOM is skipped, and `bodyStart` indexes the ORIGINAL text (BOM included) so offsets
 * stay exact for CRLF and multibyte files. CRLF is accepted at every line end.
 */
export function splitFrontMatter(text: string): { yaml: string; bodyStart: number } {
  const bom = text.startsWith('﻿') ? 1 : 0;
  const opening = /^---[ \t]*\r?\n/.exec(text.slice(bom));
  if (opening === null) {
    throw new FrontMatterInvalidError('missing', 'the file has no front matter block', 1, 1);
  }
  const start = bom + opening[0].length;
  const rest = text.slice(start);
  const m = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (m === null) {
    throw new FrontMatterInvalidError('unterminated', 'the front matter block is not terminated');
  }
  const yaml = rest.slice(0, m.index);
  if (Buffer.byteLength(yaml, 'utf8') > FRONT_MATTER_MAX_BYTES) {
    throw new FrontMatterInvalidError(
      'size',
      `the front matter block exceeds ${FRONT_MATTER_MAX_BYTES} bytes`,
    );
  }
  return { yaml, bodyStart: start + m.index + m[0].length };
}

/** The only key names the schema itself declares: the only document keys an error may name. */
const SCHEMA_KEYS = new Set([
  'feature',
  'component',
  'expected_behaviors',
  'constraints',
  'id',
  'description',
  'type',
  'value',
  'allowed',
]);

/**
 * An error message built from fixed text only: zod's own `message` is never forwarded (it can quote
 * a document key or value), and a path segment is an integer or a key the schema declares — any
 * other segment is document text and is printed as the literal `<key>`.
 */
function describeIssue(issue: z.ZodIssue | undefined): string {
  if (issue === undefined) return 'invalid';
  const path = issue.path
    .map((p) => (typeof p === 'number' ? String(p) : SCHEMA_KEYS.has(p) ? p : '<key>'))
    .join('.');
  // The only custom issue is ours: a repeated expectation id.
  return `${path}: ${issue.code === 'custom' ? 'duplicate_id' : issue.code}`;
}

function toConstraint(
  name: string,
  c: z.infer<typeof constraintValue>,
  index: number,
): ParsedConstraint {
  switch (c.type) {
    case 'duration': {
      const ms = parseDurationMs(c.value);
      if (ms === null) {
        throw new FrontMatterInvalidError(
          'duration',
          `constraints[${index}]: not a duration (use e.g. 15s; 1ms to 366d, no leading zero)`,
        );
      }
      return { name, valueType: 'duration', valueJson: ms };
    }
    case 'enum':
      if (!c.allowed.includes(c.value)) {
        throw new FrontMatterInvalidError(
          'schema',
          `constraints[${index}]: value is not in allowed`,
        );
      }
      return { name, valueType: 'enum', valueJson: { value: c.value, allowed: c.allowed } };
    default:
      return { name, valueType: c.type, valueJson: c.value };
  }
}

/** Maps a yaml diagnostic code to the one rule it names. */
function kindOf(code: string): FrontMatterErrorKind {
  if (code === 'TAB_AS_INDENT') return 'tab_indent';
  if (code === 'DUPLICATE_KEY') return 'duplicate_key';
  if (code === 'TAG_RESOLVE_FAILED') return 'unresolved_tag';
  return 'syntax';
}

export function parseFrontMatter(text: string): {
  frontMatter: ParsedFrontMatter;
  bodyStart: number;
} {
  const { yaml, bodyStart } = splitFrontMatter(text);
  const doc = parseDocument(yaml, {
    schema: 'core',
    logLevel: 'silent',
    uniqueKeys: true,
    strict: true,
  });
  // An unresolved tag (`!!js/function`) only WARNS, so errors alone would let it through.
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem !== undefined) {
    const pos = problem.linePos?.[0];
    throw new FrontMatterInvalidError(kindOf(problem.code), problem.code, pos?.line, pos?.col);
  }
  let value: unknown;
  try {
    // yaml's typings take maxAliasCount on toJS, not parseDocument (ADR 0017 lists it with parse).
    value = doc.toJS({ maxAliasCount: 10 });
  } catch (cause) {
    throw FrontMatterInvalidError.fromConversion(cause);
  }
  const parsed = frontMatterSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new FrontMatterInvalidError('schema', describeIssue(issue));
  }
  const fm = parsed.data;
  return {
    bodyStart,
    frontMatter: {
      feature: fm.feature,
      component: fm.component,
      expectedBehaviors: fm.expected_behaviors,
      constraints: Object.entries(fm.constraints).map(([n, c], i) => toConstraint(n, c, i)),
    },
  };
}
