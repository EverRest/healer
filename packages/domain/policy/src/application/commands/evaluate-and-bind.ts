import { randomUUID } from 'node:crypto';
import { scope, type TenantContext } from '@healer/shared';
import type { DecisionInput } from '../../domain/decision-input.js';
import type { AutonomyEpochRepository } from '../../domain/autonomy-epoch-repository.js';
import type { DecisionBinding, PolicyDecisionRepository, RecordedDecision } from '../../domain/policy-decision-repository.js';
import type { PolicyRulesetRepository } from '../../domain/policy-ruleset-repository.js';
import { computeProposalDigest } from '../../domain/proposal-digest.js';
import { NoPublishedRulesetError, resolveRulesetAndEvaluate } from '../resolve-ruleset-and-evaluate.js';

// Re-exported so existing callers/tests importing this error from here keep working — the error
// itself now lives in `resolve-ruleset-and-evaluate.ts` since `ExplainDecision` (T024) throws it too.
export { NoPublishedRulesetError };

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
  const { decision, trace } = await resolveRulesetAndEvaluate(repos, context, input.decisionInput);
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
