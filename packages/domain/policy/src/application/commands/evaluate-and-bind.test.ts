import { describe, expect, it } from 'vitest';
import { TenantContext, type TenantScoped } from '@healer/shared';
import type { AutonomyEpochRepository } from '../../domain/autonomy-epoch-repository.js';
import type {
  NewRecordedDecision,
  PolicyDecisionRepository,
  RecordedDecision,
} from '../../domain/policy-decision-repository.js';
import type {
  PolicyRulesetRepository,
  PublishedRuleset,
} from '../../domain/policy-ruleset-repository.js';
import { computeProposalDigest } from '../../domain/proposal-digest.js';
import { buildDecisionInput } from '../../domain/test-support/fixtures.js';
import { evaluateAndBind, NoPublishedRulesetError } from './evaluate-and-bind.js';

const CONTEXT = TenantContext.forTrustedInternalUse('00000000-0000-0000-8000-0000000000d1');

function published(overrides: Partial<PublishedRuleset> = {}): PublishedRuleset {
  return {
    id: 'ruleset-1',
    version: 1,
    digest: 'digest-1',
    publishedAt: new Date('2026-01-01T00:00:00Z'),
    publishedBy: 'pavlo',
    conflictWarnings: [],
    rules: [
      {
        ruleKey: 'allow-code-change',
        predicates: [
          {
            kind: 'enumerated',
            field: 'action.actionClass',
            operator: 'equals',
            value: 'code_change',
          },
        ],
        outcome: 'allow',
        reasonCode: 'NO_ADOPTED_EXPECTATION',
        note: '',
      },
    ],
    ...overrides,
  };
}

class FakeRulesetRepo implements PolicyRulesetRepository {
  constructor(private readonly ruleset: PublishedRuleset | null) {}
  async findByDigest(): Promise<PublishedRuleset | null> {
    return this.ruleset;
  }
  async findLatest(): Promise<PublishedRuleset | null> {
    return this.ruleset;
  }
  async publish(): Promise<PublishedRuleset> {
    throw new Error('not used by this test');
  }
  async findByVersion(): Promise<PublishedRuleset | null> {
    return this.ruleset;
  }
  async list(): Promise<readonly PublishedRuleset[]> {
    return this.ruleset === null ? [] : [this.ruleset];
  }
}

class FakeDecisionRepo implements PolicyDecisionRepository {
  recorded: TenantScoped<NewRecordedDecision>[] = [];
  async record(where: TenantScoped<NewRecordedDecision>): Promise<RecordedDecision> {
    this.recorded.push(where);
    return {
      id: where.id,
      proposalDigest: where.proposalDigest,
      outcome: where.decision.outcome,
      reasonCodes: where.decision.reasonCodes,
      rulesetVersion: where.decision.rulesetVersion,
      matchedRuleKeys: where.decision.matchedRuleKeys,
      ceilingApplied: where.decision.ceilingApplied,
      evaluatedAt: where.decision.evaluatedAt,
    };
  }
  async consume(): Promise<void> {
    throw new Error('not used by this test');
  }
  async findById(): Promise<null> {
    throw new Error('not used by this test');
  }
  async list(): Promise<readonly never[]> {
    throw new Error('not used by this test');
  }
}

class FakeEpochRepo implements AutonomyEpochRepository {
  constructor(private readonly epoch: bigint) {}
  async current(): Promise<bigint> {
    return this.epoch;
  }
}

describe('evaluateAndBind (T021)', () => {
  it('resolves the current ruleset, evaluates, and persists the decision bound to the workflow run/state', async () => {
    const decisions = new FakeDecisionRepo();
    const input = buildDecisionInput();
    const result = await evaluateAndBind(
      {
        rulesets: new FakeRulesetRepo(published()),
        decisions,
        autonomyEpochs: new FakeEpochRepo(0n),
      },
      CONTEXT,
      {
        decisionInput: input,
        binding: { workflowRunId: 'run-1', workflowState: 'awaiting_execution' },
      },
    );

    expect(result.decision.outcome).toBe('allow');
    expect(result.decision.rulesetVersion).toBe(1);
    expect(result.autonomyEpoch).toBe(0n);
    expect(decisions.recorded).toHaveLength(1);
    expect(decisions.recorded[0]).toMatchObject({
      actionKey: 'change.open_pull_request',
      targetRef: 'target-1',
      fingerprint: 'fingerprint-1',
      proposalDigest: computeProposalDigest(input),
      binding: { workflowRunId: 'run-1', workflowState: 'awaiting_execution' },
    });
  });

  it('reads a nonzero autonomy epoch when one has been bumped', async () => {
    const result = await evaluateAndBind(
      {
        rulesets: new FakeRulesetRepo(published()),
        decisions: new FakeDecisionRepo(),
        autonomyEpochs: new FakeEpochRepo(3n),
      },
      CONTEXT,
      { decisionInput: buildDecisionInput() },
    );
    expect(result.autonomyEpoch).toBe(3n);
  });

  it('refuses to evaluate when no ruleset has ever been published for the tenant', async () => {
    await expect(
      evaluateAndBind(
        {
          rulesets: new FakeRulesetRepo(null),
          decisions: new FakeDecisionRepo(),
          autonomyEpochs: new FakeEpochRepo(0n),
        },
        CONTEXT,
        { decisionInput: buildDecisionInput() },
      ),
    ).rejects.toThrow(NoPublishedRulesetError);
  });

  it('two structurally identical proposals evaluated separately get the same proposal digest', async () => {
    const decisions = new FakeDecisionRepo();
    const repos = {
      rulesets: new FakeRulesetRepo(published()),
      decisions,
      autonomyEpochs: new FakeEpochRepo(0n),
    };
    await evaluateAndBind(repos, CONTEXT, { decisionInput: buildDecisionInput() });
    await evaluateAndBind(repos, CONTEXT, { decisionInput: buildDecisionInput() });
    expect(decisions.recorded).toHaveLength(2);
    expect(decisions.recorded[0]?.proposalDigest).toBe(decisions.recorded[1]?.proposalDigest);
  });
});
