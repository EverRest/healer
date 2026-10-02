import { HealerError, scope, type TenantContext } from '@healer/shared';
import type { DecisionInput } from '../domain/decision-input.js';
import { bindingBudget } from '../domain/budget-figures.js';
import type {
  BudgetQuery,
  ReadOnlyBudgetRepository,
  ResolvedBudget,
} from '../domain/budget-repository.js';
import {
  evaluate,
  type BudgetState,
  type Decision,
  type EvaluationTrace,
} from '../domain/evaluate.js';
import type { ReadOnlyAutonomyGrantRepository } from '../domain/autonomy-grant-repository.js';
import type { PolicyActionRepository } from '../domain/policy-action-repository.js';
import type { ReadOnlyPolicyRulesetRepository } from '../domain/policy-ruleset-repository.js';
import { resolveAutonomyLevel } from '../domain/resolve-autonomy-level.js';
import type { Rule } from '../domain/rule.js';

/** No `policy_ruleset` has ever been published for this tenant — `evaluate()` needs one
 *  (contracts/evaluation.md step 1), and data-model.md's SC-003 invariant requires every
 *  `policy_decision.ruleset_version` to resolve to a real `policy_ruleset`, so this refuses
 *  rather than fabricating a phantom version 0 to evaluate against. Shared by both callers: a
 *  tenant with no published ruleset gets the same refusal whether they're binding a decision or
 *  only asking what one would be.
 *
 *  Extends `HealerError` (batch 9 follow-up review, both independent Opus reviews), not a plain
 *  `Error`, matching the rest of this package's error convention (`DecisionNotAllowedError`,
 *  `DuplicateRuleKeyError`, ...). `VALIDATION` (422) is the same substitution `DuplicateRuleKeyError`
 *  already makes for a code this closed union has no dedicated entry for.
 *
 *  This repo has no global Nest exception filter (`@Catch`/`APP_FILTER`/`useGlobalFilters`) that
 *  reads `HealerError.code` and maps it to an HTTP status — confirmed absent, not just unwired
 *  (round 3 follow-up: an earlier version of this comment claimed a future caller "would
 *  otherwise let it surface as a generic 500," which described a mechanism that does not exist).
 *  Today's one caller (`policy-evaluation.controller.ts`) still has its own explicit `instanceof`
 *  branch, unchanged by this — so right now this change is harmless and purely for convention
 *  consistency, not yet a safety net for a future caller. It becomes one only if/when a global
 *  filter is added; building that filter is out of scope here. */
export class NoPublishedRulesetError extends HealerError {
  constructor() {
    super(
      'VALIDATION',
      'no policy_ruleset has been published for this tenant — PublishRuleset must run first',
    );
    this.name = 'NoPublishedRulesetError';
  }
}

/** `input.action.actionKey` is not a registered `policy_action.action_key` (batch 9 C1(b),
 *  review finding): there is no `ALLOW` possible for an action nobody registered, so this refuses
 *  rather than evaluating against whatever the caller happened to claim. `HealerError`/
 *  `VALIDATION` for the same reason as `NoPublishedRulesetError` above. */
export class UnregisteredActionError extends HealerError {
  constructor(readonly actionKey: string) {
    super('VALIDATION', `action key "${actionKey}" is not registered in policy_action`);
    this.name = 'UnregisteredActionError';
  }
}

export interface PrepareEvaluationRepos {
  readonly rulesets: ReadOnlyPolicyRulesetRepository;
  readonly actions: PolicyActionRepository;
  readonly autonomyGrants: ReadOnlyAutonomyGrantRepository;
}

export interface ResolveRulesetAndEvaluateRepos extends PrepareEvaluationRepos {
  /** T056/T060: consumed, limit, degradation step and the escalation count are resolved here from
   *  the derived aggregate, never trusted from the caller — the same move `autonomyGrants` makes
   *  for `autonomy.level` and `actions` makes for `actionClass`. */
  readonly budgets: ReadOnlyBudgetRepository;
}

/** What `evaluate()` needs once everything except the budget is resolved. The budget is the one
 *  input that must be read **inside** the charge's lock when the step declares a cost (T060), so
 *  the two halves are separable: `prepareEvaluation` (reads, no lock) then `evaluatePrepared`
 *  (pure). */
export interface PreparedEvaluation {
  readonly version: number;
  readonly rules: readonly Rule[];
  readonly decisionInput: DecisionInput;
}

export interface EvaluatedWithBudget {
  readonly decision: Decision;
  readonly trace: EvaluationTrace;
  readonly decisionInput: DecisionInput;
  /** What the decision row persists as `budget_state`: the trace's figures plus the binder's
   *  extras (open-charge amount, escalation cap, binding scope). */
  readonly budgetState: BudgetState;
}

/** Pure: resolve the binding budget, hand `evaluate()` the figures as inputs, and return what to
 *  persist. No clock, no repository. */
export function evaluatePrepared(
  prepared: PreparedEvaluation,
  budget: ResolvedBudget,
): EvaluatedWithBudget {
  const declared = prepared.decisionInput.budget.declaredMaxCost;
  const bound = bindingBudget(budget.scopes, declared);
  const decisionInput: DecisionInput = {
    ...prepared.decisionInput,
    budget: bound.budget,
    // The count is resolved from the run, never the caller's; whether the proposal *is* an
    // escalation is the caller's structural statement and is kept.
    escalation: {
      attemptCount: budget.escalation.attemptCount,
      ...(prepared.decisionInput.escalation.escalating !== undefined
        ? { escalating: prepared.decisionInput.escalation.escalating }
        : {}),
    },
  };
  const { decision, trace } = evaluate(
    {
      version: prepared.version,
      rules: prepared.rules,
      escalationAttemptCap: budget.escalation.cap,
    },
    decisionInput,
  );
  const budgetState: BudgetState = {
    ...trace.budgetState,
    reservedSpend: declared,
    escalationAttemptCap: budget.escalation.cap,
    binding: {
      scopeType: bound.scope.scopeType,
      scopeId: bound.scope.scopeId,
      period: bound.scope.period,
      periodKey: bound.scope.periodKey,
      dimension: bound.dimension,
    },
  };
  return { decision, trace, decisionInput, budgetState };
}

/**
 * Step 1 (resolve the tenant's current published ruleset) plus the call into the pure `evaluate()`
 * (batch 3, untouched) — the logic `EvaluateAndBind` (T021) and `ExplainDecision` (T024) share
 * verbatim (contracts/evaluation.md "The two callers, and why there is no flag", R-08). Neither
 * caller duplicates this; they differ only in what they do with the result afterwards —
 * `EvaluateAndBind` persists it, `ExplainDecision` returns it.
 *
 * Takes only a read-only ruleset dependency: nothing downstream of this function can reach a
 * write-capable repository method through it, by construction of `ReadOnlyPolicyRulesetRepository`
 * (T024/T026) rather than by this function choosing not to call one. `PolicyActionRepository`
 * (T014) has no write-capable method at all, so adding it here doesn't weaken that guarantee.
 *
 * Batch 9 C1(b), review finding: before this fix, `input.action.actionClass` was whatever the
 * caller supplied, never cross-checked against the registry — a caller claiming a lower/wrong
 * class got that class's ceiling instead of the real one, defeating FR-008's un-exceedable
 * ceiling at the one point in the whole design meant to make that impossible. This looks up
 * `actionKey` in `policy_action` and **overwrites** `actionClass` with the registry's own value
 * before `evaluate()` ever sees it — chosen over removing `actionClass` from `DecisionInput`
 * entirely because `evaluate()`/`ceiling.ts`/`predicates/*` (out of scope for this batch to touch)
 * all read `action.actionClass` structurally off `DecisionInput`; splitting the type into a
 * caller-facing shape without the field and an internal one with it would touch every test and
 * fixture that builds a `DecisionInput` literal, for no additional safety over overwriting the one
 * field this function already fully controls. The corrected `decisionInput` is returned alongside
 * the decision so callers that persist it (`EvaluateAndBind`) record what was actually evaluated,
 * not what was claimed — otherwise a replay of the stored (uncorrected) input would reintroduce
 * this exact bug.
 */
export async function resolveRulesetAndEvaluate(
  repos: ResolveRulesetAndEvaluateRepos,
  context: TenantContext,
  decisionInput: DecisionInput,
  binding: Omit<BudgetQuery, 'asOf'> = {},
): Promise<EvaluatedWithBudget> {
  const prepared = await prepareEvaluation(repos, context, decisionInput);
  // Unlocked read: a dry run, or a step that declares no cost and so charges nothing, needs no
  // serialization — only the charge itself (`BudgetRepository.bindCharged`) does.
  const budget = await repos.budgets.resolve(
    scope(context, { ...binding, asOf: decisionInput.evaluatedAt }),
  );
  return evaluatePrepared(prepared, budget);
}

/** Everything except the budget: registry class, grant level, current rule set. */
export async function prepareEvaluation(
  repos: PrepareEvaluationRepos,
  context: TenantContext,
  decisionInput: DecisionInput,
): Promise<PreparedEvaluation> {
  const action = await repos.actions.findByKey(decisionInput.action.actionKey);
  if (action === null) throw new UnregisteredActionError(decisionInput.action.actionKey);

  // T039/T040/T041/T042: `autonomy.level` gets the same treatment as `actionClass` below, for the
  // same reason — a caller trusted to state its own level could simply claim L5 and the grant
  // table would never be consulted, exactly the bypass batch 9 closed for the action class.
  // `resolveAutonomyLevel` (pure) narrows by `target.componentId`/`environment`/`issueKind`
  // (quickstart 11: a grant scoped to component A does not authorize component B). This repository
  // read happens on every call, never cached across a wait, which is what makes a revocation
  // visible at the very next evaluation with no push mechanism involved (R-07).
  const activeGrants = await repos.autonomyGrants.findActive(
    scope(context, { actionKey: decisionInput.action.actionKey }),
  );
  const resolvedLevel = resolveAutonomyLevel(activeGrants, {
    actionKey: decisionInput.action.actionKey,
    componentId: decisionInput.target.componentId,
    environment: decisionInput.target.environment,
    issueKind: decisionInput.target.issueKind,
  });

  const correctedInput: DecisionInput = {
    ...decisionInput,
    action: { ...decisionInput.action, actionClass: action.actionClass },
    autonomy: { level: resolvedLevel },
  };

  const latest = await repos.rulesets.findLatest(scope(context, {}));
  if (latest === null) throw new NoPublishedRulesetError();

  const rules: readonly Rule[] = latest.rules.map((r) => ({
    ruleKey: r.ruleKey,
    predicates: r.predicates,
    outcome: r.outcome,
    reasonCode: r.reasonCode,
  }));

  return { version: latest.version, rules, decisionInput: correctedInput };
}
