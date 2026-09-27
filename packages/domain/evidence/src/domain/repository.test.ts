import { describe, expectTypeOf, it } from 'vitest';
import type { TenantScoped } from '@healer/shared';
import type { EvidenceRepository, NewEvidence } from './repository.js';

/**
 * Tenant scoping on every repository method (001 T014, FR-015, 012 T010) — see
 * `packages/domain/issues/src/domain/repository.test.ts` for the same proof against
 * `IssueRepository`, including why `repo` is a real (never-invoked) stub rather than a
 * `declare const`.
 */
const repo: EvidenceRepository = {
  record: () => Promise.reject(new Error('type-proof stub, never called')),
  findById: () => Promise.reject(new Error('type-proof stub, never called')),
  detach: () => Promise.reject(new Error('type-proof stub, never called')),
};

const NEW_EVIDENCE: NewEvidence = {
  id: 'evidence-1',
  issueId: 'issue-1',
  type: 'error_signature',
  sourceSystem: 'loki',
  sourceRef: 'ref1',
  sourceLabel: 'from logs',
  excerpt: null,
  excerptTruncated: false,
  payload: {},
  producedByStep: 'collector',
  observedAt: new Date(),
  expiresAt: new Date(),
};

/** Type-checked by `tsc --build`, never invoked — calling a rejecting stub would be noise. */
function typeProofNeverCalled(): void {
  // @ts-expect-error record requires TenantScoped<NewEvidence>, not a plain NewEvidence
  repo.record(NEW_EVIDENCE);
  // @ts-expect-error findById requires TenantScoped<{ id }>, not a plain { id }
  repo.findById({ id: 'evidence-1' });
  // @ts-expect-error detach requires TenantScoped<{ id }>, not a plain { id }
  repo.detach({ id: 'evidence-1' });
}
void typeProofNeverCalled;

describe('EvidenceRepository is tenant-scoped on every method (001 T014, FR-015)', () => {
  it('cannot be called without a proven tenant — the omission is a type error, not a runtime check', () => {
    expectTypeOf(repo.record).parameter(0).toEqualTypeOf<TenantScoped<NewEvidence>>();
  });
});
