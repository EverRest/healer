import { describe, expect, it } from 'vitest';
import { ACTION_CEILING } from './ceiling.js';
import { SEED_POLICY_ACTIONS } from './policy-action-repository.js';

/** Quickstart 8 / T047 (008 FR-024): no action of class `merge` or `forward_deploy` exists in
 *  the registry, and the ceiling has no level for either — there is nothing to grant. Both
 *  halves matter: the registry could be clean today and grow such an action tomorrow with the
 *  ceiling unchanged (still safe, `ACTION_CEILING` refuses it), or the ceiling could regress
 *  while the registry stays clean (this test alone would not catch it) — this asserts both. */
describe('no action of class merge or forward_deploy exists in the registry (T047, quickstart 8)', () => {
  it('SEED_POLICY_ACTIONS has no merge or forward_deploy entry', () => {
    const classes = SEED_POLICY_ACTIONS.map((action) => action.actionClass);
    expect(classes).not.toContain('merge');
    expect(classes).not.toContain('forward_deploy');
  });

  it('ACTION_CEILING has no level for either class, regardless of hasTestedUndo — there is nothing to grant', () => {
    expect(ACTION_CEILING('merge', false)).toEqual({ kind: 'none' });
    expect(ACTION_CEILING('merge', true)).toEqual({ kind: 'none' });
    expect(ACTION_CEILING('forward_deploy', false)).toEqual({ kind: 'none' });
    expect(ACTION_CEILING('forward_deploy', true)).toEqual({ kind: 'none' });
  });
});
