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
 * The reopen window (001 T022, FR-005, R-02): a matching signal this soon after resolution
 * reopens the issue; later than this, it starts a recurrence instead. `docs/stage-0.md` S0-7
 * names this exact value as deliberately left unset in the spec, pending S0-1's incident-cadence
 * data — 14 days is a placeholder (a common default for alerting tools), not a measured one, and
 * belongs behind per-tenant configuration once that exists, not a hardcoded constant.
 */
const REOPEN_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Fingerprint computation and attachment of a matching signal to the open issue (001 T018/T022,
 * FR-002, FR-005). Composes T016/T017's pure fingerprinting with 001 T012's repository:
 *  1. An open issue matching the fingerprint → attach (`recordOccurrence`).
 *  2. Otherwise, the most recently resolved issue matching it, if any: inside `REOPEN_WINDOW_MS`
 *     of its resolution → reopen (`transition` to `investigating`, then attach); outside it, or
 *     none ever resolved → create a new issue, linked `recurrence_of` the resolved one when there
 *     was one (data-model.md's state diagram: `resolved --inside window--> investigating`,
 *     `resolved --outside window--> new issue, recurrence_of`).
 *
 * Reopen transitions before attaching, not the other way around — matches the order the pure
 * state machine and `recordOccurrence` are independently safe to run in, and reads as "the issue
 * reopens, then the signal that reopened it is recorded", the same order the acceptance
 * scenario describes it. A crash between the two leaves the issue correctly reopened with a
 * slightly stale count, corrected by the next occurrence — not data loss, not corruption, the
 * same class of narrow window already accepted elsewhere in this module (see below).
 *
 * The window compares against the signal's own `observedAt` (R-10's source clock), not wall-clock
 * receipt time — a delayed delivery should be judged against when the failure actually happened,
 * not when it happened to arrive. A signal whose `observedAt` predates the resolved issue's own
 * `resolvedAt` (out-of-order delivery, or simply a fixture with a fixed historical timestamp)
 * takes the *recurrence* branch, not reopen: a negative difference is not "inside a window
 * measured forward from resolution", and every acceptance scenario describes the signal arriving
 * *after* resolution. Flagged in QUESTIONS.md as a real, unexercised edge case rather than a
 * considered design: a severely out-of-order signal for what is, in every other respect, the
 * same still-recent incident ends up starting a new issue instead of reopening the old one.
 *
 * Three judgment calls carried over from T018, still flagged in QUESTIONS.md:
 *  - `kind` defaults to `monitoring_alert` and `severity` to the signal's own field or `medium`
 *    when absent — the contract names six `Issue.kind` values and doesn't say which this
 *    provider-signal path uses.
 *  - `componentId` stays `null`: 004 (architecture-graph) isn't implemented, so there is no real
 *    `Component` to resolve `signal.component` against yet. The fingerprint hashes the *raw*
 *    string today; once 004 lands and can group several raw strings under one canonical
 *    `Component`, today's fingerprints may need recomputing under a new `normalisation_ruleset`
 *    version — the exact mechanism 001 T011 built to make that recompute possible.
 *  - This is a plain check-then-act (`findOpenByFingerprint`/`findMostRecentlyResolvedByFingerprint`
 *    then `create`/`transition`/`recordOccurrence`), not one atomic operation. Two concurrent
 *    *first* occurrences of a brand new fingerprint could each see "not found" and both create an
 *    issue — a real race, not something this function's tests can exercise meaningfully. 001 T026
 *    ("load check") is where that needs to be measured; a fix (a unique partial index on
 *    `(tenant_id, fingerprint) where state not in ('merged','removed')`, catching the resulting
 *    conflict and retrying as an attach) is one migration away if it turns out to matter.
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

  const resolved = await issueRepo.findMostRecentlyResolvedByFingerprint(
    scope(context, { fingerprint }),
  );
  const sinceResolved =
    resolved?.resolvedAt != null
      ? signal.observedAt.getTime() - resolved.resolvedAt.getTime()
      : null;
  const withinReopenWindow =
    sinceResolved !== null && sinceResolved >= 0 && sinceResolved <= REOPEN_WINDOW_MS;

  if (resolved !== null && withinReopenWindow) {
    await issueRepo.transition(
      scope(context, { id: resolved.id }),
      'investigating',
      'ingestion',
      'ingestion',
    );
    const reopened = await issueRepo.recordOccurrence(
      scope(context, { id: resolved.id }),
      signal.observedAt,
    );
    return { issue: reopened, created: false };
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
      ...(resolved !== null ? { recurrenceOf: resolved.id } : {}),
    }),
  );
  return { issue: created, created: true };
}
