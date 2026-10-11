import type { TenantScoped } from '@healer/shared';
import type {
  ActionLimitQuery,
  CooldownGroup,
  ReadOnlyActionLimitRepository,
} from '../action-limit.js';
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

/** No history, no bounds: what an action with nothing configured and nothing counted resolves to. */
export const EMPTY_COOLDOWN: CooldownGroup = {
  recentAllowCount: 0,
  windowSeconds: 3600,
  attemptCount: 0,
};

/** `ReadOnlyActionLimitRepository` returning a fixed group (default: nothing counted, no bounds). */
export class FakeActionLimitRepository implements ReadOnlyActionLimitRepository {
  readonly queries: ActionLimitQuery[] = [];
  constructor(private readonly group: CooldownGroup = EMPTY_COOLDOWN) {}
  async resolve(where: TenantScoped<ActionLimitQuery>): Promise<CooldownGroup> {
    this.queries.push(where);
    return this.group;
  }
}

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
    warnings: [],
    ...overrides,
  };
}

/** The read side alone — what `ExplainDecisionRepos` names, so a dry run cannot reach a write. */
export class FakeReadOnlyBudgetRepository implements ReadOnlyBudgetRepository {
  readonly queries: BudgetQuery[] = [];
  constructor(private readonly budget: ResolvedBudget = roomyBudget()) {}
  async resolve(where: TenantScoped<BudgetQuery>): Promise<ResolvedBudget> {
    this.queries.push(where);
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
    _limit: TenantScoped<ActionLimitQuery>,
    decide: (budget: ResolvedBudget, cooldown: CooldownGroup) => TenantScoped<NewRecordedDecision>,
  ): Promise<{ readonly budget: ResolvedBudget; readonly decision: RecordedDecision }> {
    this.queries.push(where);
    this.chargedBinds += 1;
    const decision = await this.decisions.record(decide(this.budget, EMPTY_COOLDOWN));
    return { budget: this.budget, decision };
  }

  readonly released: Date[] = [];
  async releaseAbandonedCharges(
    where: TenantScoped<{ readonly olderThan: Date }>,
  ): Promise<number> {
    this.released.push(where.olderThan);
    return 0;
  }

  /** Set to make every `markDegradation` fail, as a database outage after the decision committed
   *  would. */
  markError: Error | undefined;

  async markDegradation(where: TenantScoped<MarkDegradationInput>): Promise<MarkDegradationResult> {
    if (this.markError !== undefined) throw this.markError;
    this.marks.push(where);
    return { marked: true, evidenceId: `evidence-${where.step}` };
  }
}
