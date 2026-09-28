import { describe, expectTypeOf, it } from 'vitest';
import type { TenantScoped } from '@healer/shared';
import type { AuditRepository } from './audit-repository.js';
import type { NewAuditEntry } from './audit.js';

/**
 * Tenant scoping on every repository method (001 T042, FR-015) — same proof shape as
 * `packages/domain/issues/src/domain/repository.test.ts` and `domain-evidence`'s
 * `link-repository.test.ts` against this package's own real interface.
 */
const repo: AuditRepository = {
  record: () => Promise.reject(new Error('type-proof stub, never called')),
  listByTarget: () => Promise.reject(new Error('type-proof stub, never called')),
  resolveAgentRunFacts: () => Promise.reject(new Error('type-proof stub, never called')),
};

const NEW_ENTRY: NewAuditEntry = {
  id: 'entry-1',
  actorType: 'human',
  actorRef: 'pavlo',
  action: 'issue.close',
  targetType: 'issue',
  targetId: 'issue-1',
  reason: 'closing as resolved',
  evidenceIds: [],
  outcome: 'ok',
};

/** Type-checked by `tsc --build`, never invoked — calling a rejecting stub would be noise. */
function typeProofNeverCalled(): void {
  // @ts-expect-error record requires TenantScoped<NewAuditEntry>, not a plain NewAuditEntry
  repo.record(NEW_ENTRY);
  // @ts-expect-error listByTarget requires a TenantScoped filter, not a plain one
  repo.listByTarget({ targetType: 'issue', targetId: 'issue-1' });
  // @ts-expect-error resolveAgentRunFacts requires a TenantScoped filter, not a plain one
  repo.resolveAgentRunFacts({ agentRunId: 'run-1' });
}
void typeProofNeverCalled;

describe('AuditRepository is tenant-scoped on every method (001 T042, FR-015)', () => {
  it('cannot be called without a proven tenant — the omission is a type error, not a runtime check', () => {
    expectTypeOf(repo.record).parameter(0).toEqualTypeOf<TenantScoped<NewAuditEntry>>();
  });
});
