import { scope, type TenantContext } from '@healer/shared';
import type { PolicyDecisionRepository } from '../../domain/policy-decision-repository.js';

/**
 * `ConsumeDecision` (T023, contracts/evaluation.md "Binding, consumption and validity"): the
 * executor presents the decision identifier and the digest of what it is about to do. Thin, same
 * shape as `mergeIssues`/`closeIssue` — the single-use check-and-mutate is the repository's
 * atomic `consume()` (`DecisionAlreadyConsumedError` / `DigestMismatchError` / `NotFoundError`);
 * this only scopes the call to the tenant. No real executor caller exists yet (T022's tests call
 * this directly) — a future caller (008, 010) calls this immediately before performing the
 * guarded action, never across a wait (R-07).
 */
export function consumeDecision(
  repo: PolicyDecisionRepository,
  context: TenantContext,
  input: { readonly decisionId: string; readonly presentedDigest: string },
): Promise<void> {
  return repo.consume(scope(context, input));
}
