import { randomUUID } from 'node:crypto';
import { scope, type TenantContext } from '@healer/shared';
import type { Issue } from './issue.js';
import type { IssueRepository } from './repository.js';
import type { NormalisationRulesetRepository } from './normalisation-ruleset.js';
import { resolveFingerprint } from './resolve-fingerprint.js';
import type { Signal } from './signal.js';

export interface IngestSignalResult {
  readonly issue: Issue;
  readonly created: boolean;
}

/**
 * Fingerprint computation and attachment of a matching signal to the open issue (001 T018,
 * FR-002). Composes T016/T017's pure fingerprinting with 001 T012's repository: find the open
 * issue this signal's fingerprint names, attach to it, or create one when nothing open matches.
 *
 * Two judgment calls, flagged in QUESTIONS.md rather than guessed at silently:
 *  - `kind` defaults to `monitoring_alert` and `severity` to the signal's own field or `medium`
 *    when absent — the contract names six `Issue.kind` values and doesn't say which this
 *    provider-signal path uses.
 *  - `componentId` stays `null`: 004 (architecture-graph) isn't implemented, so there is no real
 *    `Component` to resolve `signal.component` against yet. The fingerprint hashes the *raw*
 *    string today; once 004 lands and can group several raw strings under one canonical
 *    `Component`, today's fingerprints may need recomputing under a new `normalisation_ruleset`
 *    version — the exact mechanism 001 T011 built to make that recompute possible.
 *
 * Also flagged: this is a plain check-then-act (`findOpenByFingerprint` then either `create` or
 * `recordOccurrence`), not one atomic operation. Two concurrent *first* occurrences of a brand
 * new fingerprint could each see "not found" and both create an issue — a real race, not
 * something this function's tests can exercise meaningfully. 001 T026 ("load check") is where
 * that needs to be measured; a fix (a unique partial index on `(tenant_id, fingerprint) where
 * state not in ('merged','removed')`, catching the resulting conflict and retrying as an attach)
 * is one migration away if it turns out to matter in practice.
 */
export async function ingestSignal(
  rulesetRepo: NormalisationRulesetRepository,
  issueRepo: IssueRepository,
  context: TenantContext,
  signal: Signal,
): Promise<IngestSignalResult> {
  const { fingerprint, rulesetVersion } = await resolveFingerprint(rulesetRepo, {
    component: signal.component,
    environment: signal.environment,
    ...(signal.errorSignature.exceptionType !== undefined
      ? { exceptionType: signal.errorSignature.exceptionType }
      : {}),
    ...(signal.errorSignature.frames !== undefined ? { frames: signal.errorSignature.frames } : {}),
    ...(signal.errorSignature.endpointTemplate !== undefined
      ? { endpointTemplate: signal.errorSignature.endpointTemplate }
      : {}),
    ...(signal.errorSignature.errorCode !== undefined
      ? { errorCode: signal.errorSignature.errorCode }
      : {}),
  });

  const existing = await issueRepo.findOpenByFingerprint(scope(context, { fingerprint }));
  if (existing !== null) {
    const attached = await issueRepo.recordOccurrence(
      scope(context, { id: existing.id }),
      signal.observedAt,
    );
    return { issue: attached, created: false };
  }

  const created = await issueRepo.create(
    scope(context, {
      id: randomUUID(),
      kind: 'monitoring_alert',
      environment: signal.environment,
      severity: signal.severity ?? 'medium',
      fingerprint,
      rulesetVersion,
      firstSeenAt: signal.observedAt,
      lastSeenAt: signal.observedAt,
    }),
  );
  return { issue: created, created: true };
}
