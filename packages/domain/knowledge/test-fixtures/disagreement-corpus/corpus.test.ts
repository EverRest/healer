import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RunnerEvidence } from '@healer/boundary-contract';
import { describe, expect, it } from 'vitest';
import { FIXTURE_FILES, claims, disagreementCorpus, groundTruth } from './index.js';

// Pinned on purpose: editing a fixture must be a deliberate act that updates its digest here
// (sha256 of the LF-normalised file content).
const DIGESTS: Record<(typeof FIXTURE_FILES)[number], string> = {
  'wiki-checkout.md': 'a0e95a2286db8c180857f9ca6789e19fe3e6b20e8b5a197ae9f79ad13376afba',
  'payment-retry.ts.txt': '031c57656e3c6dc0654778f9d9d61424eee40719be9d33761333e495c6ecff80',
  'expectations/checkout.md': 'c76f55b0016fe6595ba69c65acfd38e6c7de89c9ed87755366b55d40b2115de2',
  'observations.json': '2bb047010b24be10ee7f8f804106dd0f41062315a68ffa6e67abb1813a17faca',
};

describe('disagreement corpus (SC-006; quickstart 17, 18)', () => {
  it('encodes the disagreement: wiki=5, code=3, traces=3', () => {
    expect(claims.wiki).toBe(5);
    expect(claims.code).toBe(3);
    expect(claims.traces).toEqual([3, 3]);
  });

  it('ground truth: does 3 (observed), should 4 (adopted expectation) — distinct from every wrong source', () => {
    expect(groundTruth).toEqual({ currentBehaviorRetries: 3, intendedBehaviorRetries: 4 });
    expect([claims.wiki, claims.code]).not.toContain(groundTruth.intendedBehaviorRetries);
  });

  it('observations are valid boundary evidence', () => {
    for (const o of disagreementCorpus.observations) RunnerEvidence.parse(o);
  });

  it('fixture files match their pinned digests', () => {
    for (const name of FIXTURE_FILES) {
      const text = readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8').replace(
        /\r\n/g,
        '\n',
      );
      expect(createHash('sha256').update(text).digest('hex'), name).toBe(DIGESTS[name]);
    }
  });
});
