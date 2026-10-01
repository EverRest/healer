import { describe, expect, it } from 'vitest';
import { TenantContext, type TenantScoped } from '@healer/shared';
import type { ActionClass } from '../../domain/action-class.js';
import type { AutonomyEpochRepository } from '../../domain/autonomy-epoch-repository.js';
import type {
  AutonomyGrant,
  ReadOnlyAutonomyGrantRepository,
} from '../../domain/autonomy-grant-repository.js';
import type {
  PolicyAction,
  PolicyActionRepository,
} from '../../domain/policy-action-repository.js';
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
import {
  evaluateAndBind,
  NoPublishedRulesetError,
  UnregisteredActionError,
} from './evaluate-and-bind.js';

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
  async bump(): Promise<bigint> {
    throw new Error('not used by this test');
  }
}

/** `change.open_pull_request` → `code_change` by default, matching `buildDecisionInput`'s own
 *  fixture (T014's `SEED_POLICY_ACTIONS`) — batch 9 C1(b) made `actions` a required dependency, so
 *  every existing test needs a registry that resolves the fixture's own action key. */
class FakeActionRepo implements PolicyActionRepository {
  constructor(
    private readonly byKey: ReadonlyMap<string, ActionClass> = new Map([
      ['change.open_pull_request', 'code_change'],
    ]),
  ) {}
  async findByKey(actionKey: string): Promise<PolicyAction | null> {
    const actionClass = this.byKey.get(actionKey);
    if (actionClass === undefined) return null;
    return {
      actionKey,
      actionClass,
      mutating: true,
      owningSpec: 'test',
      introducedAt: new Date('2026-01-01T00:00:00Z'),
    };
  }
  async list(): Promise<readonly PolicyAction[]> {
    return [...this.byKey.entries()].map(([actionKey, actionClass]) => ({
      actionKey,
      actionClass,
      mutating: true,
      owningSpec: 'test',
      introducedAt: new Date('2026-01-01T00:00:00Z'),
    }));
  }
}

/** Resolves to level 2 for `change.open_pull_request` scoped to nothing in particular (a
 *  wildcard grant), matching `buildDecisionInput`'s own fixture default `autonomy: { level: 2 }`
 *  (T039 made `autonomyGrants` a required dependency, the same move batch 9 made for `actions`) —
 *  existing tests that don't care about autonomy resolution keep their exact outcomes. */
class FakeAutonomyGrantRepo implements ReadOnlyAutonomyGrantRepository {
  constructor(private readonly level = 2) {}
  async findActive(): Promise<readonly AutonomyGrant[]> {
    return [
      {
        id: 'grant-1',
        actionKey: 'change.open_pull_request',
        level: this.level,
        grantedBy: 'pavlo',
        grantedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ];
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
        actions: new FakeActionRepo(),
        autonomyGrants: new FakeAutonomyGrantRepo(),
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
        actions: new FakeActionRepo(),
        autonomyGrants: new FakeAutonomyGrantRepo(),
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
          actions: new FakeActionRepo(),
          autonomyGrants: new FakeAutonomyGrantRepo(),
        },
        CONTEXT,
        { decisionInput: buildDecisionInput() },
      ),
    ).rejects.toThrow(NoPublishedRulesetError);
  });

  // Batch 9 follow-up review (both independent Opus reviews): NoPublishedRulesetError/
  // UnregisteredActionError used to extend plain Error, unlike the rest of this package's error
  // convention (DecisionNotAllowedError, DuplicateRuleKeyError, ...). No global exception filter
  // reads HealerError.code today, so this is a convention fix, not yet a behavior change for any
  // caller — see resolve-ruleset-and-evaluate.ts's own doc comment (round 3 correction).
  it('NoPublishedRulesetError is a HealerError with code VALIDATION', async () => {
    await expect(
      evaluateAndBind(
        {
          rulesets: new FakeRulesetRepo(null),
          decisions: new FakeDecisionRepo(),
          autonomyEpochs: new FakeEpochRepo(0n),
          actions: new FakeActionRepo(),
          autonomyGrants: new FakeAutonomyGrantRepo(),
        },
        CONTEXT,
        { decisionInput: buildDecisionInput() },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('two structurally identical proposals evaluated separately get the same proposal digest', async () => {
    const decisions = new FakeDecisionRepo();
    const repos = {
      rulesets: new FakeRulesetRepo(published()),
      decisions,
      autonomyEpochs: new FakeEpochRepo(0n),
      actions: new FakeActionRepo(),
      autonomyGrants: new FakeAutonomyGrantRepo(),
    };
    await evaluateAndBind(repos, CONTEXT, { decisionInput: buildDecisionInput() });
    await evaluateAndBind(repos, CONTEXT, { decisionInput: buildDecisionInput() });
    expect(decisions.recorded).toHaveLength(2);
    expect(decisions.recorded[0]?.proposalDigest).toBe(decisions.recorded[1]?.proposalDigest);
  });
});

describe('evaluateAndBind — actionClass is derived from the registry, not the caller (batch 9 C1(b), review finding)', () => {
  it('the registry actionClass gates the ceiling even when the caller claims a lower/wrong class that would itself pass', async () => {
    const alwaysAllow = published({
      rules: [
        {
          ruleKey: 'always-allow',
          predicates: [],
          outcome: 'allow',
          reasonCode: 'NO_ADOPTED_EXPECTATION',
          note: '',
        },
      ],
    });
    // Real registry class is `merge` — ceiling `none`, no level ever granted (R-05). Claimed
    // class is `read_only` — ceiling level 1, which the proposal's `autonomy.level: 1` would pass.
    const actions = new FakeActionRepo(new Map([['merge.something', 'merge']]));
    const decisions = new FakeDecisionRepo();

    const result = await evaluateAndBind(
      {
        rulesets: new FakeRulesetRepo(alwaysAllow),
        decisions,
        autonomyEpochs: new FakeEpochRepo(0n),
        actions,
        autonomyGrants: new FakeAutonomyGrantRepo(),
      },
      CONTEXT,
      {
        decisionInput: buildDecisionInput({
          action: { actionKey: 'merge.something', actionClass: 'read_only' },
          autonomy: { level: 1 },
        }),
      },
    );

    expect(result.decision.outcome).toBe('deny');
    expect(result.decision.reasonCodes).toContain('CEILING_EXCEEDED');
    // The persisted decisionInput carries the corrected class, not the caller's claim — a replay
    // of this stored row must reproduce the same refusal, not the caller's wrong one.
    expect(decisions.recorded[0]?.decisionInput.action.actionClass).toBe('merge');
  });

  it('refuses an unregistered action key rather than evaluating against whatever the caller claims', async () => {
    await expect(
      evaluateAndBind(
        {
          rulesets: new FakeRulesetRepo(published()),
          decisions: new FakeDecisionRepo(),
          autonomyEpochs: new FakeEpochRepo(0n),
          actions: new FakeActionRepo(new Map()),
          autonomyGrants: new FakeAutonomyGrantRepo(),
        },
        CONTEXT,
        {
          decisionInput: buildDecisionInput({
            action: { actionKey: 'nobody.registered.this', actionClass: 'read_only' },
          }),
        },
      ),
    ).rejects.toThrow(UnregisteredActionError);
  });

  it('UnregisteredActionError is a HealerError with code VALIDATION', async () => {
    await expect(
      evaluateAndBind(
        {
          rulesets: new FakeRulesetRepo(published()),
          decisions: new FakeDecisionRepo(),
          autonomyEpochs: new FakeEpochRepo(0n),
          actions: new FakeActionRepo(new Map()),
          autonomyGrants: new FakeAutonomyGrantRepo(),
        },
        CONTEXT,
        {
          decisionInput: buildDecisionInput({
            action: { actionKey: 'nobody.registered.this', actionClass: 'read_only' },
          }),
        },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
