import { ACTION_CEILING } from './ceiling.js';
import type { DecisionInput } from './decision-input.js';
import { foldOutcomes, type Outcome } from './outcome-lattice.js';
import { matchesConjunction } from './predicates/evaluate-predicate.js';
import type { ReasonCode } from './reason-code.js';
import type { CooldownBounds, ResolvedRuleset, Rule } from './rule.js';

// T012: pure `evaluate(ruleset, input) → { decision, trace }`, the six ordered steps of
// contracts/evaluation.md. No clock, no repository, no network, no model — every varying input
// is the `input` parameter. No `dryRun` parameter (R-08): this same function serves both the
// persisting caller (`EvaluateAndBind`) and the read-only caller (`ExplainDecision`).

export interface MatchedRuleTrace {
  readonly ruleKey: string;
  readonly outcome: Outcome;
}

export interface BudgetState {
  readonly consumed: number;
  readonly limit: number;
  readonly declaredMaxCost: number;
  readonly degradationStep: number;
}

export interface EvaluationTrace {
  readonly matchedRules: readonly MatchedRuleTrace[];
  readonly foldResult: Outcome;
  readonly ceilingApplied: boolean;
  readonly resolvedAutonomyLevel: number;
  readonly budgetState: BudgetState;
  readonly reasonCodes: readonly ReasonCode[];
}

export interface Decision {
  readonly outcome: Outcome;
  readonly reasonCodes: readonly ReasonCode[];
  readonly rulesetVersion: number;
  readonly matchedRuleKeys: readonly string[];
  readonly ceilingApplied: boolean;
  readonly evaluatedAt: Date;
}

interface StepResult {
  readonly outcome: Outcome;
  readonly reasonCodes: readonly ReasonCode[];
}

function addReasonCode(reasonCodes: readonly ReasonCode[], code: ReasonCode): readonly ReasonCode[] {
  return reasonCodes.includes(code) ? reasonCodes : [...reasonCodes, code];
}

// Step 4: `min(level, ACTION_CEILING(actionClass, hasTestedUndo))` (FR-008). There is no
// separate autonomy step (C-17) — a rule already used the raw grant level in its own predicate
// (`autonomy.level atLeast N`) during step 2. This step is the un-exceedable clamp: whatever a
// rule concluded, a grant above the ceiling for its class can never be honoured.
// `ceilingApplied` is true only when this step actually changes the outcome (not merely when the
// clamp would mathematically differ from the raw level) — an already-DENY decision reaching here
// for an unrelated reason is not "the ceiling" applying.
function applyCeiling(current: StepResult, input: DecisionInput): StepResult {
  const ceiling = ACTION_CEILING(input.action.actionClass, input.reversibility.hasTestedUndo);
  const ceilingLevel = ceiling.kind === 'level' ? ceiling.level : 0;
  const rawLevel = input.autonomy.level;
  const clamped = Math.min(rawLevel, ceilingLevel);
  if (clamped >= rawLevel || current.outcome === 'deny') return current;
  return { outcome: 'deny', reasonCodes: addReasonCode(current.reasonCodes, 'CEILING_EXCEEDED') };
}

// Step 5: exhausted → DENY(BUDGET_EXHAUSTED); a degraded-but-not-exhausted budget only annotates
// the trace (FR-011, FR-012) — the ex-ante "would this step cross the limit" check is Phase 6
// (T059/T060), not part of this pure fold.
function applyBudget(current: StepResult, input: DecisionInput): StepResult {
  if (input.budget.consumed < input.budget.limit) return current;
  return {
    outcome: 'deny',
    reasonCodes: addReasonCode(current.reasonCodes, 'BUDGET_EXHAUSTED'),
  };
}

// Step 6: rate, cooldown and attempt-cap counts over the window for
// `(actionKey, targetRef, fingerprint)` (FR-014, R-13, C-11). Bounds are resolved alongside the
// rule set (`ResolvedRuleset.cooldownBounds`) — absent when the tenant has none configured for
// this action, in which case there is nothing to enforce.
function applyCooldown(current: StepResult, input: DecisionInput, bounds: CooldownBounds | undefined): StepResult {
  if (!bounds) return current;
  const { cooldown } = input;
  let result = current;
  if (cooldown.attemptCount >= bounds.attemptCap) {
    result = { outcome: 'deny', reasonCodes: addReasonCode(result.reasonCodes, 'ATTEMPT_CAP_REACHED') };
  }
  if (cooldown.recentAllowCount >= bounds.ratePerWindow) {
    result = { outcome: 'deny', reasonCodes: addReasonCode(result.reasonCodes, 'RATE_LIMITED') };
  }
  if (cooldown.recentAllowCount >= 1 && cooldown.windowSeconds < bounds.cooldownSeconds) {
    result = { outcome: 'deny', reasonCodes: addReasonCode(result.reasonCodes, 'COOLDOWN') };
  }
  return result;
}

function budgetStateOf(input: DecisionInput): BudgetState {
  return {
    consumed: input.budget.consumed,
    limit: input.budget.limit,
    declaredMaxCost: input.budget.declaredMaxCost,
    degradationStep: input.budget.degradationStep,
  };
}

export function evaluate(
  ruleset: ResolvedRuleset,
  input: DecisionInput,
): { readonly decision: Decision; readonly trace: EvaluationTrace } {
  // Step 2: match — every rule whose predicate conjunction holds, no ordering, no priority.
  const matched: readonly Rule[] = ruleset.rules.filter((rule) => matchesConjunction(rule.predicates, input));

  // Step 3: fold — max over ALLOW < REQUIRE_APPROVAL < DENY, seeded DENY for the empty set.
  const foldResult = foldOutcomes(matched.map((rule) => rule.outcome));
  const baseReasonCodes: readonly ReasonCode[] =
    matched.length === 0
      ? ['NO_MATCHING_RULE']
      : dedupeReasonCodes(matched.filter((rule) => rule.outcome === foldResult).map((rule) => rule.reasonCode));

  let step: StepResult = { outcome: foldResult, reasonCodes: baseReasonCodes };
  step = applyCeiling(step, input);
  const ceilingApplied = step.outcome !== foldResult;
  step = applyBudget(step, input);
  step = applyCooldown(step, input, ruleset.cooldownBounds);

  const trace: EvaluationTrace = {
    matchedRules: matched.map((rule) => ({ ruleKey: rule.ruleKey, outcome: rule.outcome })),
    foldResult,
    ceilingApplied,
    resolvedAutonomyLevel: input.autonomy.level,
    budgetState: budgetStateOf(input),
    reasonCodes: step.reasonCodes,
  };

  const decision: Decision = {
    outcome: step.outcome,
    reasonCodes: step.reasonCodes,
    rulesetVersion: ruleset.version,
    matchedRuleKeys: matched.map((rule) => rule.ruleKey),
    ceilingApplied,
    evaluatedAt: input.evaluatedAt,
  };

  return { decision, trace };
}

function dedupeReasonCodes(codes: readonly ReasonCode[]): readonly ReasonCode[] {
  return Array.from(new Set(codes));
}
