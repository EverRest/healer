import { describe, expect, it } from 'vitest';
import {
  ALLOWED_COLUMNS,
  findColumnViolations,
  findRowViolations,
  PATH_PATTERN,
} from './no-payload-at-rest.mjs';

describe('findColumnViolations (003 T031, R-13)', () => {
  it('accepts exactly the allowed column set', () => {
    expect(findColumnViolations([...ALLOWED_COLUMNS])).toEqual([]);
  });

  it('reports a column that could hold a payload, and a missing one', () => {
    const columns = [...ALLOWED_COLUMNS.filter((c) => c !== 'byte_size'), 'raw_body'];
    expect(findColumnViolations(columns)).toEqual([
      'boundary_rejection has a column outside the allowed list: raw_body',
      'boundary_rejection is missing the expected column: byte_size',
    ]);
  });
});

describe('findRowViolations', () => {
  const ok = {
    id: 'r1',
    payload_digest: 'a'.repeat(64),
    schema_error_paths: ['items.0.evidence#unrecognized_keys', '$#invalid_json', '<key>.x#custom'],
  };

  it('accepts a digest and structural paths', () => {
    expect(findRowViolations([ok])).toEqual([]);
  });

  it('reports a digest that is not 64 hex chars', () => {
    expect(findRowViolations([{ ...ok, payload_digest: 'A'.repeat(64) }])).toEqual([
      'boundary_rejection r1: payload_digest is not 64 lowercase hex characters',
    ]);
  });

  it('reports prose in a path without echoing it', () => {
    const violations = findRowViolations([
      { ...ok, schema_error_paths: ['user jane@example.com failed'] },
    ]);
    expect(violations).toEqual([
      'boundary_rejection r1: schema_error_paths[0] is not a structural path',
    ]);
    expect(violations.join()).not.toContain('jane');
  });

  it('bounds a path at 200 characters', () => {
    expect(PATH_PATTERN.test('a'.repeat(200))).toBe(true);
    expect(PATH_PATTERN.test('a'.repeat(201))).toBe(false);
  });
});
