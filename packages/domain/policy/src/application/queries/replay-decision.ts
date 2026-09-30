import { scope, type TenantContext } from '@healer/shared';
import type { DecisionInput } from '../../domain/decision-input.js';
import { evaluate, type Decision } from '../../domain/evaluate.js';
import type { ReadOnlyPolicyRulesetRepository } from '../../domain/policy-ruleset-repository.js';
import type { Rule } from '../../domain/rule.js';

/** The stored decision's own `ruleset_version` no longer resolves — cannot happen for a row this
 *  repository itself wrote (SC-003: "a version cited by a decision resolves forever"), so this
 *  would mean the guarantee itself broke, not a normal 404. */
export class RulesetVersionNotFoundError extends Error {
  constructor(readonly version: number) {
    super(`policy_ruleset version ${version} no longer resolves for this tenant`);
    this.name = 'RulesetVersionNotFoundError';
  }
}

export interface ReplayDecisionRepos {
  readonly rulesets: ReadOnlyPolicyRulesetRepository;
}

/**
 * `POST /policy/decisions/{decisionId}/replay` (T028, FR-002): re-runs the pure `evaluate()`
 * against a stored decision's own recorded `decisionInput` and `rulesetVersion` — the *historical*
 * ruleset, never the tenant's current one, which is what actually proves determinism against
 * history rather than merely re-evaluating under today's rules (contracts/evaluation.md).
 *
 * "A differing outcome is an incident, not a test failure" (contract) — this reports the
 * comparison and never throws on a mismatch; only an unresolvable ruleset version throws, since
 * that violates SC-003 rather than merely disagreeing with history.
 */
export async function replayDecision(
  repos: ReplayDecisionRepos,
  context: TenantContext,
  stored: {
    readonly decisionInput: DecisionInput;
    readonly rulesetVersion: number;
    readonly outcome: Decision['outcome'];
    readonly matchedRuleKeys: readonly string[];
  },
): Promise<{ readonly identical: boolean; readonly replayed: Decision }> {
  const ruleset = await repos.rulesets.findByVersion(
    scope(context, { version: stored.rulesetVersion }),
  );
  if (ruleset === null) throw new RulesetVersionNotFoundError(stored.rulesetVersion);

  const rules: readonly Rule[] = ruleset.rules.map((r) => ({
    ruleKey: r.ruleKey,
    predicates: r.predicates,
    outcome: r.outcome,
    reasonCode: r.reasonCode,
  }));

  const { decision } = evaluate({ version: ruleset.version, rules }, stored.decisionInput);
  // data-model.md's Invariants: "`evaluate(ruleset_version, decision_input) = (outcome,
  // matched_rule_keys)` replays identically" — both halves of that pair, not only `outcome`
  // (batch 9 C2, review finding: comparing outcome alone would call two decisions identical even
  // when a different set of rules matched to reach the same fold result).
  const identical =
    decision.outcome === stored.outcome &&
    sameRuleKeys(decision.matchedRuleKeys, stored.matchedRuleKeys);
  return { identical, replayed: decision };
}

function sameRuleKeys(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((key, i) => key === sortedB[i]);
}
