import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  COLLECTOR_KEYS,
  FOLLOW_UP_REASONS,
  GAP_REASON_CODES,
  ITEM_CLASSES,
  SOURCE_STATUSES,
} from '@healer/boundary-contract';

/**
 * The Prisma enums are a mirror of the boundary's closed lists (003 T002): `boundary-contract` is
 * the one authority, so a list edited there without the schema (or the reverse) fails here instead
 * of surfacing as a runtime enum mismatch on the first write.
 */
const SCHEMA = readFileSync(
  fileURLToPath(new URL('../../../../../prisma/schema.prisma', import.meta.url)),
  'utf8',
);

function enumValues(name: string): string[] {
  const body = new RegExp(`^enum ${name} \\{([^}]*)\\}`, 'm').exec(SCHEMA)?.[1];
  if (body === undefined) throw new Error(`enum ${name} not found in schema.prisma`);
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('//') && !l.startsWith('@@'));
}

describe('Prisma enums mirror the boundary-contract closed lists', () => {
  it.each([
    ['CollectorKey', COLLECTOR_KEYS],
    ['ItemClass', ITEM_CLASSES],
    ['SourceStatus', SOURCE_STATUSES],
    ['GapReasonCode', GAP_REASON_CODES],
    ['FollowUpReason', FOLLOW_UP_REASONS],
  ] as const)('%s equals its boundary list exactly, in order', (name, list) => {
    expect(enumValues(name)).toEqual([...list]);
  });
});

describe('control-plane schema', () => {
  it('has no withholding ledger — it lives in the execution plane only (R-08, FR-009)', () => {
    expect(SCHEMA.toLowerCase()).not.toContain('withholding');
  });
});
