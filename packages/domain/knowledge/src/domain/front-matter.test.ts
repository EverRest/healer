import { describe, expect, it } from 'vitest';
import { BROKEN_FRONT_MATTER } from '../testing/broken-front-matter.js';
import {
  FRONT_MATTER_INVALID,
  FRONT_MATTER_MAX_BYTES,
  FrontMatterInvalidError,
  MAX_DURATION_MS,
  parseDurationMs,
  parseFrontMatter,
} from './front-matter.js';

const wrap = (yaml: string, body = '## Body\n') => `---\n${yaml}\n---\n${body}`;
const OK = `feature: checkout
component: checkout-api
expected_behaviors:
  - id: checkout-002
    description: a payment is retried at most max_payment_retries times
constraints:
  max_payment_retries: { type: int, value: 4 }
  reservation_timeout: { type: duration, value: 15s }
  mode: { type: enum, value: fast, allowed: [fast, safe] }`;

function failure(text: string): FrontMatterInvalidError {
  try {
    parseFrontMatter(text);
  } catch (e) {
    expect(e).toBeInstanceOf(FrontMatterInvalidError);
    return e as FrontMatterInvalidError;
  }
  throw new Error('expected FRONT_MATTER_INVALID, got a parse');
}

describe('parseFrontMatter (T017/T018, ADR 0017)', () => {
  it('parses typed constraints from the block, durations as milliseconds', () => {
    const { frontMatter, bodyStart } = parseFrontMatter(wrap(OK));
    expect(frontMatter.expectedBehaviors).toEqual([
      { id: 'checkout-002', description: 'a payment is retried at most max_payment_retries times' },
    ]);
    expect(frontMatter.constraints).toEqual([
      { name: 'max_payment_retries', valueType: 'int', valueJson: 4 },
      { name: 'reservation_timeout', valueType: 'duration', valueJson: 15000 },
      { name: 'mode', valueType: 'enum', valueJson: { value: 'fast', allowed: ['fast', 'safe'] } },
    ]);
    expect(wrap(OK).slice(bodyStart)).toBe('## Body\n');
  });

  it('parses durations purely, within a stated range', () => {
    expect(parseDurationMs('15s')).toBe(15000);
    expect(parseDurationMs('2m')).toBe(120000);
    expect(parseDurationMs('250ms')).toBe(250);
    expect(parseDurationMs('1d')).toBe(86400000);
    expect(parseDurationMs('366d')).toBe(MAX_DURATION_MS);
    for (const bad of [
      '15',
      's',
      '1.5s',
      '-1s',
      '15 s',
      'fifteen seconds',
      '',
      '0s', // zero
      '0ms',
      '007s', // leading zeros
      '00s',
      '367d', // over the cap
      '999999999d', // would be unsafe-integer territory without the cap
      '9999999999s', // more digits than the grammar allows
    ]) {
      expect(parseDurationMs(bad), bad).toBeNull();
    }
    expect(Number.isSafeInteger(MAX_DURATION_MS)).toBe(true);
  });

  for (const [name, { text, kind }] of Object.entries(BROKEN_FRONT_MATTER)) {
    it(`fails ${name} with ${FRONT_MATTER_INVALID}/${kind}`, () => {
      const e = failure(text);
      expect(e.code).toBe(FRONT_MATTER_INVALID);
      expect(e.kind).toBe(kind);
    });
  }

  it('measures the cap on the raw block before parsing it', () => {
    // 64 KiB of syntactically invalid YAML: only a cap checked first yields the size reason.
    const text = `---\n${'\t'.repeat(FRONT_MATTER_MAX_BYTES + 1)}\n---\n`;
    expect(failure(text).kind).toBe('size');
  });

  it('keeps the cause of a non-alias conversion failure instead of calling it an alias error', () => {
    // A merge-less but valid doc cannot fail toJS for another reason, so exercise the mapping
    // through the exported classifier.
    const cause = new TypeError('boom');
    const e = FrontMatterInvalidError.fromConversion(cause);
    expect(e.kind).toBe('syntax');
    expect(e.cause).toBe(cause);
    const alias = FrontMatterInvalidError.fromConversion(
      new ReferenceError('Excessive alias count indicates a resource exhaustion attack'),
    );
    expect(alias.kind).toBe('alias_limit');
  });

  it('strips a leading BOM and keeps offsets in the original text', () => {
    const text = `﻿${wrap(OK)}`;
    const { frontMatter, bodyStart } = parseFrontMatter(text);
    expect(frontMatter.feature).toBe('checkout');
    expect(text.slice(bodyStart)).toBe('## Body\n');
  });

  it('accepts CRLF line endings and still addresses the body exactly', () => {
    const text = wrap(OK).replaceAll('\n', '\r\n');
    const { frontMatter, bodyStart } = parseFrontMatter(text);
    expect(frontMatter.constraints).toHaveLength(3);
    expect(text.slice(bodyStart)).toBe('## Body\r\n');
  });

  describe('document text never reaches an error message (R-11)', () => {
    const HOSTILE = 'IGNORE-PREVIOUS-INSTRUCTIONS';
    const base = 'feature: f\ncomponent: c\n';
    const cases: Record<string, string> = {
      'unknown top-level key': `${base}${HOSTILE}: x`,
      'hostile key shaped like a safe name': `${base}ignore_previous_instructions_${HOSTILE}: x`,
      'hostile constraint name': `${base}constraints:\n  ${HOSTILE}: { type: int, value: 1 }`,
      'hostile constraint name (valid shape)': `${base}constraints:\n  ignore_previous_instructions: { type: int, value: 1, ${HOSTILE}: 1 }`,
      'hostile constraint type': `${base}constraints:\n  a: { type: ${HOSTILE}, value: 1 }`,
      'hostile enum value': `${base}constraints:\n  a: { type: enum, value: ${HOSTILE}, allowed: [x] }`,
      'hostile duration': `${base}constraints:\n  a: { type: duration, value: ${HOSTILE} }`,
      'hostile expectation id': `${base}expected_behaviors:\n  - { id: "${HOSTILE} !", description: d }`,
      'hostile expectation key': `${base}expected_behaviors:\n  - { id: a-1, description: d, ${HOSTILE}: 1 }`,
      'hostile value of a typed field': `feature: [${HOSTILE}]\ncomponent: c`,
      'hostile yaml syntax': `${base}x: [${HOSTILE}`,
      'hostile tag': `feature: !${HOSTILE} x\ncomponent: c`,
    };
    for (const [name, yaml] of Object.entries(cases)) {
      it(`leaks nothing: ${name}`, () => {
        const e = failure(wrap(yaml));
        expect(e.message).not.toContain(HOSTILE);
        expect(String(e)).not.toContain(HOSTILE);
        expect(e.message.toLowerCase()).not.toContain('ignore');
        expect(e.reason).not.toContain(HOSTILE);
      });
    }

    it('constrains constraint names and ids to a closed, short shape', () => {
      const id = (v: string) =>
        wrap(`${base}expected_behaviors:\n  - { id: "${v}", description: d }`);
      expect(() => parseFrontMatter(id('a'.repeat(64)))).not.toThrow();
      expect(failure(id('a'.repeat(65))).kind).toBe('schema');
      expect(failure(id('Upper-1')).kind).toBe('schema');
      const name = (v: string) => wrap(`${base}constraints:\n  ${v}: { type: int, value: 1 }`);
      expect(() => parseFrontMatter(name('a'.repeat(64)))).not.toThrow();
      expect(failure(name('a'.repeat(65))).kind).toBe('schema');
    });
  });
});
