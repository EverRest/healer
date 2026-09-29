import { randomUUID } from 'node:crypto';
import { scope, type TenantContext } from '@healer/shared';
import type { DecisionInput } from '../../domain/decision-input.js';
import { evaluate } from '../../domain/evaluate.js';
import type { AutonomyEpochRepository } from '../../domain/autonomy-epoch-repository.js';
import type { DecisionBinding, PolicyDecisionRepository, RecordedDecision } from '../../domain/policy-decision-repository.js';
import type { PolicyRulesetRepository } from '../../domain/policy-ruleset-repository.js';
import { computeProposalDigest } from '../../domain/proposal-digest.js';
import type { Rule } from '../../domain/rule.js';

/** No `policy_ruleset` has ever been published for this tenant — `evaluate()` needs one
 *  (contracts/evaluation.md step 1), and data-model.md's SC-003 invariant requires every
 *  `policy_decision.ruleset_version` to resolve to a real `policy_ruleset`, so this refuses
 *  rather than fabricating a phantom version 0 to evaluate against and persist a decision that
 *  would violate that invariant on sight. */
export class NoPublishedRulesetError extends Error {
  constructor() {
    super('no policy_ruleset has been published for this tenant — PublishRuleset must run first');
    this.name = 'NoPublishedRulesetError';
  }
}

export interface EvaluateAndBindRepos {
  readonly rulesets: PolicyRulesetRepository;
  readonly decisions: PolicyDecisionRepository;
  readonly autonomyEpochs: AutonomyEpochRepository;
}

export interface EvaluateAndBindResult {
  readonly decision: RecordedDecision;
  /**
   * The tenant's current `autonomy_epoch` (0 when no row exists — no revocation has ever
   * happened, indistinguishable from "the mechanism doesn't exist yet" until Phase 4's
   * `GrantAutonomy`/`RevokeAutonomy` land). Returned rather than persisted onto `policy_decision`:
   * data-model.md's own `policy_decision` column list has no `autonomy_epoch` field — only
   * `approval_request` does, for the epoch-staleness check at approval redemption (R-07), which
   * is a different mechanism from this batch's single-use consumption (T023 checks only
   * `consumed_at` and `proposal_digest`, per contracts/evaluation.md and the brief). Adding a
   * column contracts/evaluation.md's prose gestures at but data-model.md never lists is a schema
   * change this batch does not make; Phase 4 is where the epoch mechanism — and whatever column
   * it actually needs — gets built deliberately, not by a drive-by migration here.
   */
  readonly autonomyEpoch: bigint;
}

/**
 * `EvaluateAndBind` (T021, contracts/evaluation.md). Resolves the tenant's current published
 * ruleset (step 1), calls the pure `evaluate()` batch 3 already built and proved, then persists
 * the decision bound to the workflow run/state and the proposal's own digest, and reads the
 * tenant's autonomy epoch (see `EvaluateAndBindResult`'s doc comment for why that value is
 * returned rather than written to a column that does not exist).
 *
 * `evaluate()` itself is untouched — this only resolves its inputs and persists its output.
 */
export async function evaluateAndBind(
  repos: EvaluateAndBindRepos,
  context: TenantContext,
  input: { readonly decisionInput: DecisionInput; readonly binding?: DecisionBinding },
): Promise<EvaluateAndBindResult> {
  const latest = await repos.rulesets.findLatest(scope(context, {}));
  if (latest === null) throw new NoPublishedRulesetError();

  const rules: readonly Rule[] = latest.rules.map((r) => ({
    ruleKey: r.ruleKey,
    predicates: r.predicates,
    outcome: r.outcome,
    reasonCode: r.reasonCode,
  }));

  const { decision, trace } = evaluate({ version: latest.version, rules }, input.decisionInput);
  const proposalDigest = computeProposalDigest(input.decisionInput);
  const autonomyEpoch = await repos.autonomyEpochs.current(scope(context, {}));

  const recorded = await repos.decisions.record(
    scope(context, {
      id: randomUUID(),
      decision,
      decisionInput: input.decisionInput,
      proposalDigest,
      budgetState: trace.budgetState,
      actionKey: input.decisionInput.action.actionKey,
      targetRef: input.decisionInput.target.targetRef,
      fingerprint: input.decisionInput.target.fingerprint,
      binding: input.binding ?? {},
    }),
  );

  return { decision: recorded, autonomyEpoch };
}
