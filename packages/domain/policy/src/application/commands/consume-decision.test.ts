import { describe, expect, it } from 'vitest';
import { TenantContext, type TenantScoped } from '@healer/shared';
import {
  DecisionAlreadyConsumedError,
  DigestMismatchError,
  type ConsumeDecisionInput,
  type PolicyDecisionRepository,
  type RecordedDecision,
} from '../../domain/policy-decision-repository.js';
import { consumeDecision } from './consume-decision.js';

const CONTEXT = TenantContext.forTrustedInternalUse('00000000-0000-0000-8000-0000000000e1');

class FakeDecisionRepo implements PolicyDecisionRepository {
  calls: TenantScoped<ConsumeDecisionInput>[] = [];
  constructor(private readonly effect: () => void = () => undefined) {}
  async record(): Promise<RecordedDecision> {
    throw new Error('not used by this test');
  }
  async consume(where: TenantScoped<ConsumeDecisionInput>): Promise<void> {
    this.calls.push(where);
    this.effect();
  }
}

describe('consumeDecision (T023)', () => {
  it('scopes the presented digest and decision id to the tenant before delegating to the repository', async () => {
    const repo = new FakeDecisionRepo();
    await consumeDecision(repo, CONTEXT, { decisionId: 'd1', presentedDigest: 'digest-1' });
    expect(repo.calls).toEqual([{ decisionId: 'd1', presentedDigest: 'digest-1', tenantId: CONTEXT.tenantId }]);
  });

  it('propagates DecisionAlreadyConsumedError from the repository', async () => {
    const repo = new FakeDecisionRepo(() => {
      throw new DecisionAlreadyConsumedError('d1');
    });
    await expect(consumeDecision(repo, CONTEXT, { decisionId: 'd1', presentedDigest: 'x' })).rejects.toThrow(
      DecisionAlreadyConsumedError,
    );
  });

  it('propagates DigestMismatchError from the repository', async () => {
    const repo = new FakeDecisionRepo(() => {
      throw new DigestMismatchError('d1');
    });
    await expect(consumeDecision(repo, CONTEXT, { decisionId: 'd1', presentedDigest: 'wrong' })).rejects.toThrow(
      DigestMismatchError,
    );
  });
});
