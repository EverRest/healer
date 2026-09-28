import { describe, expectTypeOf, it } from 'vitest';
import type { TenantScoped } from '@healer/shared';
import type { IssueRepository, NewIssue } from './repository.js';

/**
 * Tenant scoping on every repository method (001 T014, FR-015, 012 T010): a query without a
 * `TenantContext` fails to type-check, not merely a lint rule or a runtime check — proven the
 * same way `packages/shared/src/tenancy/tenancy.test.ts` proves the primitive, but against this
 * package's own real interface rather than a stand-in.
 *
 * `repo` is a real (never-invoked) stub, not a `declare const`: `expectTypeOf` and the
 * `@ts-expect-error` calls below reference it as a value, and vitest's esbuild transform strips
 * types without erasing that reference — an ambient declaration would throw `ReferenceError` the
 * moment anything here actually runs.
 */
const repo: IssueRepository = {
  create: () => Promise.reject(new Error('type-proof stub, never called')),
  findById: () => Promise.reject(new Error('type-proof stub, never called')),
  findOpenByFingerprint: () => Promise.reject(new Error('type-proof stub, never called')),
  findMostRecentlyResolvedByFingerprint: () =>
    Promise.reject(new Error('type-proof stub, never called')),
  transition: () => Promise.reject(new Error('type-proof stub, never called')),
  recordOccurrence: () => Promise.reject(new Error('type-proof stub, never called')),
  findOpenCorrelationCandidates: () => Promise.reject(new Error('type-proof stub, never called')),
  correlate: () => Promise.reject(new Error('type-proof stub, never called')),
  list: () => Promise.reject(new Error('type-proof stub, never called')),
  findRelationships: () => Promise.reject(new Error('type-proof stub, never called')),
  findStaleCandidates: () => Promise.reject(new Error('type-proof stub, never called')),
  markStale: () => Promise.reject(new Error('type-proof stub, never called')),
};

const NEW_ISSUE: NewIssue = {
  id: 'issue-1',
  kind: 'production_incident',
  environment: 'prod',
  severity: 'high',
  fingerprint: 'fp1',
  rulesetVersion: 1,
  firstSeenAt: new Date(),
  lastSeenAt: new Date(),
};

/** Type-checked by `tsc --build`, never invoked — calling a rejecting stub would be noise. */
function typeProofNeverCalled(): void {
  // @ts-expect-error create requires TenantScoped<NewIssue>, not a plain NewIssue
  repo.create(NEW_ISSUE);
  // @ts-expect-error findById requires TenantScoped<{ id }>, not a plain { id }
  repo.findById({ id: 'issue-1' });
  // @ts-expect-error findOpenByFingerprint requires TenantScoped<{ fingerprint }>, not a plain one
  repo.findOpenByFingerprint({ fingerprint: 'fp1' });
  // @ts-expect-error findMostRecentlyResolvedByFingerprint requires TenantScoped<{ fingerprint }>
  repo.findMostRecentlyResolvedByFingerprint({ fingerprint: 'fp1' });
  // @ts-expect-error transition's `where` requires TenantScoped<{ id }>, not a plain { id }
  repo.transition({ id: 'issue-1' }, 'investigating', 'agent', 'x');
  // @ts-expect-error recordOccurrence's `where` requires TenantScoped<{ id }>, not a plain { id }
  repo.recordOccurrence({ id: 'issue-1' }, new Date());
  // @ts-expect-error findOpenCorrelationCandidates requires a TenantScoped filter, not a plain one
  repo.findOpenCorrelationCandidates({
    componentId: 'c1',
    environment: 'prod',
    excludeId: 'issue-1',
    since: new Date(),
    until: new Date(),
  });
  // @ts-expect-error correlate's `where` requires a TenantScoped filter, not a plain one
  repo.correlate({ id: 'issue-1', otherId: 'issue-2', rule: 'x' });
  // @ts-expect-error list requires a TenantScoped filter, not a plain one
  repo.list({});
  // @ts-expect-error findRelationships requires a TenantScoped<{ id }>, not a plain { id }
  repo.findRelationships({ id: 'issue-1' });
  // @ts-expect-error findStaleCandidates requires a TenantScoped filter, not a plain one
  repo.findStaleCandidates({ idleBefore: new Date() });
  // @ts-expect-error markStale requires a TenantScoped filter, not a plain one
  repo.markStale({ id: 'issue-1', at: new Date(), lastProgressAt: new Date() });
}
void typeProofNeverCalled;

describe('IssueRepository is tenant-scoped on every method (001 T014, FR-015)', () => {
  it('cannot be called without a proven tenant — the omission is a type error, not a runtime check', () => {
    expectTypeOf(repo.create).parameter(0).toEqualTypeOf<TenantScoped<NewIssue>>();
  });
});
