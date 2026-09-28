import { describe, expect, it } from 'vitest';
import {
  checkMerge,
  InvalidMergeError,
  MERGE_REASON_MAX_LENGTH,
  MergeIntegrityError,
  UnmergeFingerprintTakenError,
} from './merge.js';
import type { Issue } from './issue.js';

/**
 * What must be true before an issue may be merged into another (001 T049, FR-016, R-08) — pure, so
 * every refusal is provable without a database. The repository calls this under the row locks of
 * both issues; that the answer is still true when it writes is the repository's job, not this
 * function's.
 */
function issue(id: string, state: Issue['state'] = 'investigating'): Issue {
  return {
    id,
    tenantId: 'tenant-1',
    kind: 'production_incident',
    componentId: null,
    environment: 'prod',
    severity: 'high',
    state,
    fingerprint: `fp-${id}`,
    rulesetVersion: 1,
    occurrenceCount: 1n,
    firstSeenAt: new Date('2026-01-01T00:00:00Z'),
    lastSeenAt: new Date('2026-01-01T00:00:00Z'),
    staleAt: null,
    resolvedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };
}

const REASON = 'same NPE, different provider';

/** `checkMerge(source, target, liveTargetId, sourceHasMergedChildren, reason)`. */
describe('checkMerge (001 T049, FR-016)', () => {
  it('accepts two distinct, unmerged issues and a reason', () => {
    expect(checkMerge(issue('a'), issue('b'), null, false, REASON)).toBe('merge');
  });

  it('accepts a resolved source and a resolved target — cleaning up duplicates is the common case', () => {
    expect(checkMerge(issue('a', 'resolved'), issue('b', 'resolved'), null, false, REASON)).toBe(
      'merge',
    );
  });

  it('refuses merging an issue into itself', () => {
    expect(() => checkMerge(issue('a'), issue('a'), null, false, REASON)).toThrow(
      InvalidMergeError,
    );
  });

  it.each(['merged', 'removed'] as const)('refuses a target that is %s — no chains', (state) => {
    expect(() => checkMerge(issue('a'), issue('b', state), null, false, REASON)).toThrow(
      InvalidMergeError,
    );
  });

  it('refuses a source that other issues are merged into — no chains', () => {
    expect(() => checkMerge(issue('a'), issue('b'), null, true, REASON)).toThrow(/merged into it/);
  });

  it('a source merged into this very target is the merge already done', () => {
    expect(checkMerge(issue('a', 'merged'), issue('b'), 'b', false, REASON)).toBe('already_merged');
  });

  it('a source merged into a different issue is refused (unmerge it first)', () => {
    expect(() => checkMerge(issue('a', 'merged'), issue('b'), 'c', false, REASON)).toThrow(
      InvalidMergeError,
    );
  });

  it('the repeat is still checked: a target that has since been removed, or a blank reason, fail it', () => {
    expect(() =>
      checkMerge(issue('a', 'merged'), issue('b', 'removed'), 'b', false, REASON),
    ).toThrow(InvalidMergeError);
    expect(() => checkMerge(issue('a', 'merged'), issue('b'), 'b', false, ' ')).toThrow(
      InvalidMergeError,
    );
  });

  it('a merged source with no live relationship is an integrity failure, not a merge', () => {
    expect(() => checkMerge(issue('a', 'merged'), issue('b'), null, false, REASON)).toThrow(
      MergeIntegrityError,
    );
  });

  it('refuses a blank reason and one over the bound', () => {
    expect(() => checkMerge(issue('a'), issue('b'), null, false, '   ')).toThrow(InvalidMergeError);
    expect(() =>
      checkMerge(issue('a'), issue('b'), null, false, 'x'.repeat(MERGE_REASON_MAX_LENGTH + 1)),
    ).toThrow(InvalidMergeError);
    expect(
      checkMerge(issue('a'), issue('b'), null, false, 'x'.repeat(MERGE_REASON_MAX_LENGTH)),
    ).toBe('merge');
  });
});

describe('the unmerge errors (001 T050)', () => {
  it('MergeIntegrityError names which invariant broke, and is distinguishable by it', () => {
    const missing = new MergeIntegrityError('merge_record_missing', 'i1');
    const vanished = new MergeIntegrityError('relationship_vanished', 'i1');
    expect(missing).toBeInstanceOf(MergeIntegrityError);
    expect(missing.reason).toBe('merge_record_missing');
    expect(vanished.reason).toBe('relationship_vanished');
    expect(missing.message).not.toBe(vanished.message);
  });

  it('UnmergeFingerprintTakenError carries the real fingerprint and the state it could not restore', () => {
    const error = new UnmergeFingerprintTakenError('i1', 'fp-123', 'investigating');
    expect(error).toMatchObject({
      issueId: 'i1',
      fingerprint: 'fp-123',
      restoreTo: 'investigating',
    });
    expect(error.message).toContain('fp-123');
    expect(error.name).toBe('UnmergeFingerprintTakenError');
  });
});
