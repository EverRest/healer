import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INVALIDATED_REASONS } from './invalidated-reason.js';

// A closed list has exactly one authority; the documents that restate it must agree with it.
const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../../${rel}`, import.meta.url)), 'utf8');

describe('INVALIDATED_REASONS', () => {
  it('data-model.md lists exactly the members', () => {
    const row = read('specs/002-policy-and-autonomy/data-model.md')
      .split('\n')
      .find((l) => l.startsWith('| invalidated_reason'));
    expect(row).toBeDefined();
    const listed = [...(row ?? '').matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
    expect(listed).toEqual([...INVALIDATED_REASONS]);
  });

  it('openapi.yaml enumerates exactly the members (plus null)', () => {
    const line = read('specs/002-policy-and-autonomy/contracts/openapi.yaml')
      .split('\n')
      .find((l) => l.includes('enum: [epoch_bump'));
    expect(line).toBeDefined();
    const listed = (line ?? '')
      .replace(/.*enum: \[/, '')
      .replace(/\].*/, '')
      .split(',')
      .map((s) => s.trim());
    expect(listed).toEqual([...INVALIDATED_REASONS, 'null']);
  });
});
