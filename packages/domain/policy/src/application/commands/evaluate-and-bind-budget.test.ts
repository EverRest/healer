import { describe, expect, it } from 'vitest';
import { TenantContext, type TenantScoped } from '@healer/shared';
import type { ResolvedBudget } from '../../domain/budget-repository.js';
import type { PolicyAction } from '../../domain/policy-action-repository.js';
import type {
  NewRecordedDecision,
  PolicyDecisionRepository,
  RecordedDecision,
} from '../../domain/policy-decision-repository.js';
import type { PublishedRuleset } from '../../domain/policy-ruleset-repository.js';
import {
  FakeBudgetRepository,
  roomyBudget,
} from '../../domain/test-support/fake-budget-repository.js';
import { buildDecisionInput } from '../../domain/test-support/fixtures.js';
import { evaluateAndBind, type EvaluateAndBindRepos } from './evaluate-and-bind.js';

// T056/T060/T066: the budget group and the escalation count are resolved from the derived
// aggregate, never trusted from the caller — the same move T039 made for `autonomy.level`.

const CONTEXT = TenantContext.forTrustedInternalUse('00000000-0000-0000-8000-0000000000d2');

const ruleset: PublishedRuleset = {
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
};

class RecordingDecisions implements PolicyDecisionRepository {
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
  async consume(): Promise<void> {}
  async findById(): Promise<null> {
    return null;
  }
  async list(): Promise<readonly never[]> {
    return [];
  }
}

const action: PolicyAction = {
  actionKey: 'change.open_pull_request',
  actionClass: 'code_change',
  mutating: true,
  owningSpec: 'test',
  introducedAt: new Date('2026-01-01T00:00:00Z'),
};

function reposWith(budget: ResolvedBudget) {
  const decisions = new RecordingDecisions();
  const budgets = new FakeBudgetRepository(decisions, budget);
  const repos: EvaluateAndBindRepos = {
    rulesets: {
      findByDigest: async () => ruleset,
      findLatest: async () => ruleset,
      findByVersion: async () => ruleset,
      list: async () => [ruleset],
      publish: async () => ruleset,
    },
    decisions,
    autonomyEpochs: { current: async () => 0n, bump: async () => 1n },
    actions: { findByKey: async () => action, list: async () => [action] },
    autonomyGrants: {
      findActive: async () => [
        {
          id: 'grant-1',
          actionKey: 'change.open_pull_request',
          level: 2,
          grantedBy: 'pavlo',
          grantedAt: new Date('2026-01-01T00:00:00Z'),
        },
      ],
    },
    budgets,
  };
  return { decisions, budgets, repos };
}

const nearlyFull = (consumed: number): ResolvedBudget => {
  const base = roomyBudget();
  return { ...base, scopes: [{ ...base.scopes[0]!, spendConsumed: consumed, spendLimit: 100 }] };
};

describe('evaluateAndBind — budget resolution (T056, T060, T066)', () => {
  it('a caller claiming plenty of headroom is overwritten by the resolved figures', async () => {
    const { repos, decisions } = reposWith(nearlyFull(99));
    const result = await evaluateAndBind(repos, CONTEXT, {
      decisionInput: buildDecisionInput({
        budget: { consumed: 0, limit: 1_000_000, declaredMaxCost: 5, degradationStep: 0 },
      }),
    });
    expect(result.decision.outcome).toBe('deny');
    expect(result.decision.reasonCodes).toContain('BUDGET_EXHAUSTED');
    expect(decisions.recorded[0]?.decisionInput.budget).toMatchObject({
      consumed: 99,
      limit: 100,
      declaredMaxCost: 5,
    });
  });

  it('a step that declares a cost is bound under the charge lock', async () => {
    const { repos, budgets } = reposWith(roomyBudget());
    await evaluateAndBind(repos, CONTEXT, { decisionInput: buildDecisionInput() });
    expect(budgets.chargedBinds).toBe(1);
  });

  it('a step that declares no cost charges nothing and takes no lock', async () => {
    const { repos, budgets, decisions } = reposWith(roomyBudget());
    await evaluateAndBind(repos, CONTEXT, {
      decisionInput: buildDecisionInput({
        budget: { consumed: 0, limit: 100, declaredMaxCost: 0, degradationStep: 0 },
      }),
    });
    expect(budgets.chargedBinds).toBe(0);
    expect(decisions.recorded).toHaveLength(1);
  });

  it('persists what the open charge and a faithful replay need: reserved spend, cap, binding scope', async () => {
    const { repos, decisions } = reposWith(roomyBudget());
    await evaluateAndBind(repos, CONTEXT, { decisionInput: buildDecisionInput() });
    expect(decisions.recorded[0]?.budgetState).toMatchObject({
      reservedSpend: 1,
      escalationAttemptCap: 2,
      binding: { scopeType: 'tenant', period: 'day', periodKey: '2026-01-01', dimension: 'spend' },
    });
  });

  it('the escalation count and cap come from the resolved budget, not the caller (FR-013)', async () => {
    const { repos } = reposWith(roomyBudget({ escalation: { attemptCount: 2, cap: 2 } }));
    const result = await evaluateAndBind(repos, CONTEXT, {
      decisionInput: buildDecisionInput({ escalation: { attemptCount: 0 } }),
    });
    expect(result.decision.outcome).toBe('deny');
    expect(result.decision.reasonCodes).toContain('ATTEMPT_CAP_REACHED');
  });

  it('marks the degradation steps the evaluation found, attached to the bound issue', async () => {
    const { repos, budgets } = reposWith(nearlyFull(60));
    await evaluateAndBind(repos, CONTEXT, {
      decisionInput: buildDecisionInput(),
      binding: { issueId: 'issue-1' },
    });
    expect(budgets.marks.map((m) => [m.step, m.issueId])).toEqual([[1, 'issue-1']]);
  });

  it('resolves the budget for the bound run and issue, at the decision instant', async () => {
    const { repos, budgets } = reposWith(roomyBudget());
    const input = buildDecisionInput();
    await evaluateAndBind(repos, CONTEXT, {
      decisionInput: input,
      binding: { issueId: 'issue-1', workflowRunId: 'run-1' },
    });
    expect(budgets.queries[0]).toMatchObject({
      issueId: 'issue-1',
      workflowRunId: 'run-1',
      asOf: input.evaluatedAt,
    });
  });
});
