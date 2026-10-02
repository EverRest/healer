import { randomUUID } from 'node:crypto';
import { createLogger, scope, type TenantContext } from '@healer/shared';
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
import { computeRequestKey } from '../../domain/request-key.js';
import {
  NoPublishedRulesetError,
  UnregisteredActionError,
  evaluatePrepared,
  prepareEvaluation,
} from '../resolve-ruleset-and-evaluate.js';
import { markDegradation, type MarkDegradationCommand } from './mark-degradation.js';

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
  /** Where a failed post-commit step is reported (structured, tenant-tagged). Defaults to a pino
   *  logger; a test passes its own. */
  readonly log?: { error(fields: Record<string, unknown>, message: string): void };
}

const defaultLog = createLogger({ serviceName: 'domain-policy' });

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
  //
  // The epoch is read **first** (review I3): read after a lock wait it would be newer than the
  // grants this evaluation resolved, and a revocation that landed during the wait would be hidden
  // behind an epoch the result claims to have been evaluated under. It is also read before
  // anything is charged, so its failure cannot strand a committed decision.
  const autonomyEpoch = await repos.autonomyEpochs.current(scope(context, {}));
  const prepared = await prepareEvaluation(repos, context, input.decisionInput);
  const binding = input.binding ?? {};
  const query = scope<BudgetQuery>(context, {
    ...(binding.issueId !== undefined ? { issueId: binding.issueId } : {}),
    ...(binding.workflowRunId !== undefined ? { workflowRunId: binding.workflowRunId } : {}),
    asOf: input.decisionInput.evaluatedAt,
    enforcing: true,
  });
  const charges = input.decisionInput.budget.declaredMaxCost > 0;
  const requestKey = charges ? computeRequestKey(input.decisionInput) : undefined;

  let refusedBy: MarkDegradationCommand['refusedBy'];
  const build = (budget: ResolvedBudget): NewRecordedDecision => {
    const { decision, decisionInput, budgetState } = evaluatePrepared(prepared, budget);
    if (decision.reasonCodes.includes('BUDGET_EXHAUSTED') && budgetState.binding !== undefined) {
      const { scopeType, scopeId, periodKey } = budgetState.binding;
      refusedBy = { scopeType, scopeId, periodKey };
    }
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
      ...(requestKey !== undefined ? { requestKey } : {}),
    };
  };

  // A step that declares a cost is a *charge*: the decision's declared maximum has to be visible
  // to the next evaluation the moment this one commits, so resolve-and-persist run under one
  // serialization lock (T060). A step that declares none charges nothing and needs no lock.
  let budget: ResolvedBudget;
  let recorded: RecordedDecision;
  if (charges) {
    ({ budget, decision: recorded } = await repos.budgets.bindCharged(query, (b) =>
      scope(context, build(b)),
    ));
  } else {
    budget = await repos.budgets.resolve(query); // `enforcing`: instant, issue and run are checked
    recorded = await repos.decisions.record(scope(context, build(budget)));
  }

  // After the commit, so best-effort: the decision exists and a retry would charge again, which is
  // the worse failure. A step that could not be recorded is derived, not remembered — the next
  // evaluation in the scope finds it missing and records it — so the failure is reported
  // (structured, tenant-tagged) and not thrown.
  try {
    await markDegradation(repos.budgets, context, {
      budget,
      ...(binding.issueId !== undefined ? { issueId: binding.issueId } : {}),
      asOf: input.decisionInput.evaluatedAt,
      ...(refusedBy !== undefined ? { refusedBy } : {}),
    });
  } catch (err) {
    (repos.log ?? defaultLog).error(
      { tenantId: context.tenantId, decisionId: recorded.id, err: String(err) },
      'recording a budget degradation step failed after the decision committed; the next evaluation records it',
    );
  }

  return { decision: recorded, autonomyEpoch };
}
