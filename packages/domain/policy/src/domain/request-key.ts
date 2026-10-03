import { createHash } from 'node:crypto';
import { canonicalize } from './canonicalize.js';
import type { DecisionInput } from './decision-input.js';

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
