import { createHash } from 'node:crypto';
import { canonicalize } from './canonicalize.js';
import type { DecisionInput } from './decision-input.js';
import type { DecisionBinding } from './policy-decision-repository.js';

/** One step of a workflow run, as the idempotency index knows it. A replay of the step is
 *  re-evaluated with its own earlier live allow left out of every count and charge. */
export interface StepKey {
  readonly workflowRunId: string;
  readonly workflowState: string;
  readonly requestKey: string;
}

/** The step a decision is bound to; none for a decision not bound to both a run and a state. */
export function stepKeyOf(binding: DecisionBinding, requestKey: string): StepKey | undefined {
  const { workflowRunId, workflowState } = binding;
  return workflowRunId === undefined || workflowState === undefined
    ? undefined
    : { workflowRunId, workflowState, requestKey };
}

/**
 * The idempotency key of a charged step (T060): a digest of the caller's request with every field
 * the evaluation **resolves** — the budget figures (only the declared maximum is the step's own),
 * the escalation count, the autonomy level, the action class, the cooldown counts — and the instant
 * removed. `proposal_digest` cannot serve: it is over the *resolved* input, so it changes whenever
 * the budget moves, which is exactly when a retry arrives.
 */
export function computeRequestKey(input: DecisionInput): string {
  const { evaluatedAt: _instant, budget, autonomy: _level, cooldown: _counts, ...rest } = input;
  const request = {
    ...rest,
    action: { actionKey: input.action.actionKey },
    budget: { declaredMaxCost: budget.declaredMaxCost },
    escalation: { escalating: input.escalation.escalating === true },
  };
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(request)))
    .digest('hex');
}
