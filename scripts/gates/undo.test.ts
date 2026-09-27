import { describe, expect, it } from 'vitest';
import { catalogueEntries } from './undo.mjs';

describe('gate-undo (012 T030, FR-014)', () => {
  it('finds no catalogue yet — 010 has not landed', () => {
    expect(catalogueEntries()).toEqual([]);
  });
});
