import { HealerError, scope, type TenantContext } from '@healer/shared';
import type { DecisionInput } from '../domain/decision-input.js';
import { evaluate, type Decision, type EvaluationTrace } from '../domain/evaluate.js';
import type { PolicyActionRepository } from '../domain/policy-action-repository.js';
import type { ReadOnlyPolicyRulesetRepository } from '../domain/policy-ruleset-repository.js';
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
 *  `DuplicateRuleKeyError`, ...): today's one caller (`policy-evaluation.controller.ts`) catches
 *  this by name and maps it to 422, but a future caller that doesn't copy that exact
 *  `instanceof` check would otherwise let it surface as a generic 500. `VALIDATION` (422) is the
 *  same substitution `DuplicateRuleKeyError` already makes for a code this closed union has no
 *  dedicated entry for. */
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

export interface ResolveRulesetAndEvaluateRepos {
  readonly rulesets: ReadOnlyPolicyRulesetRepository;
  readonly actions: PolicyActionRepository;
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
): Promise<{
  readonly decision: Decision;
  readonly trace: EvaluationTrace;
  readonly decisionInput: DecisionInput;
}> {
  const action = await repos.actions.findByKey(decisionInput.action.actionKey);
  if (action === null) throw new UnregisteredActionError(decisionInput.action.actionKey);

  const correctedInput: DecisionInput = {
    ...decisionInput,
    action: { ...decisionInput.action, actionClass: action.actionClass },
  };

  const latest = await repos.rulesets.findLatest(scope(context, {}));
  if (latest === null) throw new NoPublishedRulesetError();

  const rules: readonly Rule[] = latest.rules.map((r) => ({
    ruleKey: r.ruleKey,
    predicates: r.predicates,
    outcome: r.outcome,
    reasonCode: r.reasonCode,
  }));

  const { decision, trace } = evaluate({ version: latest.version, rules }, correctedInput);
  return { decision, trace, decisionInput: correctedInput };
}
