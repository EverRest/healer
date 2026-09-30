import { describe, expectTypeOf, it } from 'vitest';
import type { TenantScoped } from '@healer/shared';
import type { GraphNodeRepository } from './graph-node-repository.js';

/**
 * Tenant scoping on `GraphNodeRepository` (004 T012, FR-024, 012 T010): a query built without a
 * `TenantContext` fails to type-check, proven the same way
 * `packages/domain/issues/src/domain/repository.test.ts` proves it for `IssueRepository` — against
 * this package's own real interface, not a stand-in.
 *
 * `repo` is a real (never-invoked) stub, not a `declare const`: `expectTypeOf` and the
 * `@ts-expect-error` call below reference it as a value, and vitest's esbuild transform strips
 * types without erasing that reference — an ambient declaration would throw `ReferenceError` the
 * moment anything here actually runs.
 */
const repo: GraphNodeRepository = {
  renameNaturalKey: () => Promise.reject(new Error('type-proof stub, never called')),
};

/** Type-checked by `tsc --build`, never invoked — calling a rejecting stub would be noise. */
function typeProofNeverCalled(): void {
  // @ts-expect-error renameNaturalKey's `where` requires TenantScoped<{ id }>, not a plain { id }
  repo.renameNaturalKey({ id: 'node-1' }, 'new-key');
}
void typeProofNeverCalled;

describe('GraphNodeRepository is tenant-scoped on every method (004 T012, FR-024)', () => {
  it('cannot be called without a proven tenant — the omission is a type error, not a runtime check', () => {
    expectTypeOf(repo.renameNaturalKey)
      .parameter(0)
      .toEqualTypeOf<TenantScoped<{ readonly id: string }>>();
  });
});
