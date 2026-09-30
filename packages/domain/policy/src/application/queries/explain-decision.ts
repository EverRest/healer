import type { TenantContext } from '@healer/shared';
import type { DecisionInput } from '../../domain/decision-input.js';
import type { Decision, EvaluationTrace } from '../../domain/evaluate.js';
import type { ReadOnlyPolicyRulesetRepository } from '../../domain/policy-ruleset-repository.js';
import { resolveRulesetAndEvaluate } from '../resolve-ruleset-and-evaluate.js';

/**
 * `ExplainDecision` (T024, contracts/evaluation.md "The two callers, and why there is no flag";
 * R-08; quickstart 30-32). The read-only counterpart to `EvaluateAndBind`: same input, same
 * `evaluate()`, but returns `{ decision, trace }` and persists nothing — no `policy_decision` row,
 * no outbox publish, no proposal needs to exist beforehand. It's what 011's simulator and the
 * future `/policy/dry-run` HTTP endpoint call.
 *
 * The critical property (R-08, quickstart 32) is structural, not a runtime choice this function
 * makes: `ExplainDecisionRepos` names only `ReadOnlyPolicyRulesetRepository`, which has no
 * write-capable method at all (T026 proves this of the type itself). There is no decisions
 * repository and no autonomy-epoch repository in scope here — this handler has nothing to persist
 * and nothing that would need one, so neither is a dependency, not merely an unused one.
 */
export interface ExplainDecisionRepos {
  readonly rulesets: ReadOnlyPolicyRulesetRepository;
}

export async function explainDecision(
  repos: ExplainDecisionRepos,
  context: TenantContext,
  input: { readonly decisionInput: DecisionInput },
): Promise<{ readonly decision: Decision; readonly trace: EvaluationTrace }> {
  return resolveRulesetAndEvaluate(repos, context, input.decisionInput);
}
