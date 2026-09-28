import { describe, expectTypeOf, it } from 'vitest';
import type { TenantScoped } from '@healer/shared';
import type { IssueMergeRepository } from './merge-repository.js';

/**
 * Tenant scoping on merge and unmerge (001 T049/T050, FR-015): a call without a proven tenant is a
 * type error, checked by `tsc --build` — same proof as `repository.test.ts` gives `IssueRepository`.
 */
const repo: IssueMergeRepository = {
  merge: () => Promise.reject(new Error('type-proof stub, never called')),
  unmerge: () => Promise.reject(new Error('type-proof stub, never called')),
};

/** Type-checked by `tsc --build`, never invoked. */
function typeProofNeverCalled(): void {
  // @ts-expect-error merge's `where` requires a TenantScoped filter, not a plain one
  repo.merge({ id: 'issue-1', intoId: 'issue-2' }, 'pavlo', 'r');
  // @ts-expect-error unmerge's `where` requires TenantScoped<{ id }>, not a plain { id }
  repo.unmerge({ id: 'issue-1' }, 'pavlo');
}
void typeProofNeverCalled;

describe('IssueMergeRepository is tenant-scoped on every method (001 T049/T050, FR-015)', () => {
  it('cannot be called without a proven tenant — the omission is a type error', () => {
    expectTypeOf(repo.merge)
      .parameter(0)
      .toEqualTypeOf<TenantScoped<{ readonly id: string; readonly intoId: string }>>();
    expectTypeOf(repo.unmerge).parameter(0).toEqualTypeOf<TenantScoped<{ readonly id: string }>>();
  });
});
