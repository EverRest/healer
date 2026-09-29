import { describe, expect, it } from 'vitest';
import { SEED_POLICY_ACTIONS as REGISTRY_SEED } from '@healer/domain-policy';
import { SEED_POLICY_ACTIONS as BOOTSTRAP_SEED } from './db-seed.mjs';

/**
 * `db-seed.mjs` duplicates `SEED_POLICY_ACTIONS` by hand instead of importing
 * `@healer/domain-policy` (review-noted constraint: `make bootstrap` runs this script with plain
 * `node` before any build step exists, so a workspace-package import would need a `dist/` that
 * isn't there yet). Two copies of the same closed list is exactly the failure AGENTS.md warns
 * about ("a closed list has exactly one authority") unless something watches them for drift —
 * this is that something: it fails the moment a third action key lands in one copy and not the
 * other, instead of `make bootstrap` silently seeding an incomplete registry on a fresh checkout.
 */
describe('db-seed.mjs policy_action rows mirror @healer/domain-policy (002 T014)', () => {
  it('matches SEED_POLICY_ACTIONS exactly', () => {
    expect(BOOTSTRAP_SEED).toEqual(REGISTRY_SEED);
  });
});
