import { describe, expect, it } from 'vitest';
import { ACTION_CEILING } from './ceiling.js';

// T011: the ceiling is a pure clamp, and "no level" is a real absence in the return type — not
// 0, which is itself a level (R-05, C-18).

describe('ACTION_CEILING', () => {
  it('read_only → L1', () => {
    expect(ACTION_CEILING('read_only', false)).toEqual({ kind: 'level', level: 1 });
  });

  it('code_change → L2', () => {
    expect(ACTION_CEILING('code_change', false)).toEqual({ kind: 'level', level: 2 });
  });

  it('repository_write → L2, distinct from code_change (D-12)', () => {
    expect(ACTION_CEILING('repository_write', false)).toEqual({ kind: 'level', level: 2 });
  });

  it('reversible_remediation → L5 when the undo is tested', () => {
    expect(ACTION_CEILING('reversible_remediation', true)).toEqual({ kind: 'level', level: 5 });
  });

  it('reversible_remediation → no level at all when the undo is unattested (C-18)', () => {
    expect(ACTION_CEILING('reversible_remediation', false)).toEqual({ kind: 'none' });
  });

  it('merge, forward_deploy, irreversible → no level, ever, regardless of hasTestedUndo', () => {
    for (const actionClass of ['merge', 'forward_deploy', 'irreversible'] as const) {
      expect(ACTION_CEILING(actionClass, true)).toEqual({ kind: 'none' });
      expect(ACTION_CEILING(actionClass, false)).toEqual({ kind: 'none' });
    }
  });

  it('hasTestedUndo has no effect outside reversible_remediation', () => {
    expect(ACTION_CEILING('read_only', true)).toEqual(ACTION_CEILING('read_only', false));
    expect(ACTION_CEILING('code_change', true)).toEqual(ACTION_CEILING('code_change', false));
    expect(ACTION_CEILING('repository_write', true)).toEqual(ACTION_CEILING('repository_write', false));
  });
});
