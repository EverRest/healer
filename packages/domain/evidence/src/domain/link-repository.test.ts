import { describe, expect, expectTypeOf, it } from 'vitest';
import type { TenantScoped } from '@healer/shared';
import {
  DuplicateEvidenceLinkError,
  type EvidenceLinkRepository,
  type NewEvidenceLink,
} from './link-repository.js';

/**
 * Tenant scoping on every repository method (001 T014, FR-015, 012 T010) — see
 * `packages/domain/issues/src/domain/repository.test.ts` for the same proof against
 * `IssueRepository`, including why `repo` is a real (never-invoked) stub rather than a
 * `declare const`.
 */
const repo: EvidenceLinkRepository = {
  write: () => Promise.reject(new Error('type-proof stub, never called')),
  hasLinks: () => Promise.reject(new Error('type-proof stub, never called')),
};

const NEW_LINK: NewEvidenceLink = {
  id: 'link-1',
  evidenceId: 'evidence-1',
  conclusionType: 'diagnosis',
  conclusionId: 'conclusion-1',
  relation: 'supports',
};

/** Type-checked by `tsc --build`, never invoked — calling a rejecting stub would be noise. */
function typeProofNeverCalled(): void {
  // @ts-expect-error write requires TenantScoped<NewEvidenceLink>, not a plain NewEvidenceLink
  repo.write(NEW_LINK);
  // @ts-expect-error hasLinks requires a TenantScoped filter, not a plain one
  repo.hasLinks({ conclusionType: 'diagnosis', conclusionId: 'conclusion-1' });
}
void typeProofNeverCalled;

describe('EvidenceLinkRepository is tenant-scoped on every method (001 T014, FR-015)', () => {
  it('cannot be called without a proven tenant — the omission is a type error, not a runtime check', () => {
    expectTypeOf(repo.write).parameter(0).toEqualTypeOf<TenantScoped<NewEvidenceLink>>();
  });
});

describe('DuplicateEvidenceLinkError (001 T028)', () => {
  it('carries the three fields that identify the repeated link and names them in its message', () => {
    const error = new DuplicateEvidenceLinkError('evidence-1', 'conclusion-1', 'supports');
    expect(error.name).toBe('DuplicateEvidenceLinkError');
    expect(error.evidenceId).toBe('evidence-1');
    expect(error.conclusionId).toBe('conclusion-1');
    expect(error.relation).toBe('supports');
    expect(error.message).toBe(
      'evidence evidence-1 already has a "supports" link to conclusion conclusion-1',
    );
  });
});
