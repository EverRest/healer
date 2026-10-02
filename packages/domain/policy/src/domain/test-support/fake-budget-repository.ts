import type { TenantScoped } from '@healer/shared';
import type { ScopeFigures } from '../budget-figures.js';
import type {
  BudgetQuery,
  BudgetRepository,
  MarkDegradationInput,
  MarkDegradationResult,
  ReadOnlyBudgetRepository,
  ResolvedBudget,
} from '../budget-repository.js';
import { DEGRADATION_ORDER } from '../degradation.js';
import type {
  NewRecordedDecision,
  PolicyDecisionRepository,
  RecordedDecision,
} from '../policy-decision-repository.js';

/** Generous figures matching `buildDecisionInput`'s own budget group (consumed 0 of 100), so a
 *  test that is not about budgets sees the same outcome whether the figures were resolved or
 *  supplied. */
export function roomyBudget(overrides: Partial<ResolvedBudget> = {}): ResolvedBudget {
  const tenantDay: ScopeFigures = {
    scopeType: 'tenant',
    scopeId: 'tenant',
    period: 'day',
    periodKey: '2026-01-01',
    spendConsumed: 0,
    spendLimit: 100,
    timeConsumedMs: 0,
    timeLimitMs: 86_400_000,
    softThresholdPcts: [50, 75, 90],
  };
  return {
    scopes: [tenantDay],
    escalation: { attemptCount: 0, cap: 2 },
    degradationOrder: DEGRADATION_ORDER,
    ...overrides,
  };
}

/** The read side alone — what `ExplainDecisionRepos` names, so a dry run cannot reach a write. */
export class FakeReadOnlyBudgetRepository implements ReadOnlyBudgetRepository {
  constructor(private readonly budget: ResolvedBudget = roomyBudget()) {}
  async resolve(): Promise<ResolvedBudget> {
    return this.budget;
  }
}

/** In-memory `BudgetRepository`: fixed figures, and `bindCharged` persists through the supplied
 *  decisions fake so existing `EvaluateAndBind` tests keep asserting on what was recorded. */
export class FakeBudgetRepository implements BudgetRepository {
  readonly marks: MarkDegradationInput[] = [];
  readonly queries: BudgetQuery[] = [];
  chargedBinds = 0;

  constructor(
    private readonly decisions: PolicyDecisionRepository,
    private readonly budget: ResolvedBudget = roomyBudget(),
  ) {}

  async resolve(where: TenantScoped<BudgetQuery>): Promise<ResolvedBudget> {
    this.queries.push(where);
    return this.budget;
  }

  async bindCharged(
    where: TenantScoped<BudgetQuery>,
    decide: (budget: ResolvedBudget) => TenantScoped<NewRecordedDecision>,
  ): Promise<{ readonly budget: ResolvedBudget; readonly decision: RecordedDecision }> {
    this.queries.push(where);
    this.chargedBinds += 1;
    const decision = await this.decisions.record(decide(this.budget));
    return { budget: this.budget, decision };
  }

  async markDegradation(where: TenantScoped<MarkDegradationInput>): Promise<MarkDegradationResult> {
    this.marks.push(where);
    return { marked: true, evidenceId: `evidence-${where.step}` };
  }
}
