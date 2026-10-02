import { randomUUID } from 'node:crypto';
import { scope, type TenantContext } from '@healer/shared';
import type { DecisionInput } from '../../domain/decision-input.js';
import type { AutonomyEpochRepository } from '../../domain/autonomy-epoch-repository.js';
import type { ReadOnlyAutonomyGrantRepository } from '../../domain/autonomy-grant-repository.js';
import type { PolicyActionRepository } from '../../domain/policy-action-repository.js';
import type {
  BudgetQuery,
  BudgetRepository,
  ResolvedBudget,
} from '../../domain/budget-repository.js';
import type {
  DecisionBinding,
  NewRecordedDecision,
  PolicyDecisionRepository,
  RecordedDecision,
} from '../../domain/policy-decision-repository.js';
import type { PolicyRulesetRepository } from '../../domain/policy-ruleset-repository.js';
import { computeProposalDigest } from '../../domain/proposal-digest.js';
import {
  NoPublishedRulesetError,
  UnregisteredActionError,
  evaluatePrepared,
  prepareEvaluation,
} from '../resolve-ruleset-and-evaluate.js';
import { markDegradation } from './mark-degradation.js';

// Re-exported so existing callers/tests importing these errors from here keep working — both now
// live in `resolve-ruleset-and-evaluate.ts` since `ExplainDecision` (T024) throws them too.
export { NoPublishedRulesetError, UnregisteredActionError };

export interface EvaluateAndBindRepos {
  readonly rulesets: PolicyRulesetRepository;
  readonly decisions: PolicyDecisionRepository;
  readonly autonomyEpochs: AutonomyEpochRepository;
  readonly actions: PolicyActionRepository;
  readonly autonomyGrants: ReadOnlyAutonomyGrantRepository;
  readonly budgets: BudgetRepository;
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
  // `prepared.decisionInput` is the *corrected* one (batch 9 C1(b), T039) — `action.actionClass`
  // and `autonomy.level` overwritten with the registry's and the grants' real values — and the
  // budget group is overwritten the same way below (T056, T060). The digest and the persisted row
  // are built from the corrected input, never from the caller's claim: persisting the uncorrected
  // input would let a replay reintroduce the exact bug this fix closes.
  const prepared = await prepareEvaluation(repos, context, input.decisionInput);
  const binding = input.binding ?? {};
  const query = scope<BudgetQuery>(context, {
    ...(binding.issueId !== undefined ? { issueId: binding.issueId } : {}),
    ...(binding.workflowRunId !== undefined ? { workflowRunId: binding.workflowRunId } : {}),
    asOf: input.decisionInput.evaluatedAt,
  });

  const build = (budget: ResolvedBudget): NewRecordedDecision => {
    const { decision, decisionInput, budgetState } = evaluatePrepared(prepared, budget);
    return {
      id: randomUUID(),
      decision,
      decisionInput,
      proposalDigest: computeProposalDigest(decisionInput),
      budgetState,
      actionKey: decisionInput.action.actionKey,
      targetRef: decisionInput.target.targetRef,
      fingerprint: decisionInput.target.fingerprint,
      binding,
    };
  };

  // A step that declares a cost is a *charge*: the decision's declared maximum has to be visible
  // to the next evaluation the moment this one commits, so resolve-and-persist run under one
  // serialization lock (T060). A step that declares none charges nothing and needs no lock.
  let budget: ResolvedBudget;
  let recorded: RecordedDecision;
  if (input.decisionInput.budget.declaredMaxCost > 0) {
    ({ budget, decision: recorded } = await repos.budgets.bindCharged(query, (b) =>
      scope(context, build(b)),
    ));
  } else {
    budget = await repos.budgets.resolve(query);
    recorded = await repos.decisions.record(scope(context, build(budget)));
  }

  const autonomyEpoch = await repos.autonomyEpochs.current(scope(context, {}));
  await markDegradation(repos.budgets, context, {
    budget,
    ...(binding.issueId !== undefined ? { issueId: binding.issueId } : {}),
    asOf: input.decisionInput.evaluatedAt,
  });

  return { decision: recorded, autonomyEpoch };
}
