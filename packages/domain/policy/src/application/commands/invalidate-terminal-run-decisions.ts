import { scope, TenantContext, type TenantScoped } from '@healer/shared';

/** The part of a 001 `IssueStateChanged` outbox event this consumer reads. */
export interface IssueStateChangedEvent {
  readonly name: string;
  readonly tenantId: string;
  /** The issue (001 contracts/events.md: `subjectId` is the aggregate the event is about). */
  readonly subjectId: string;
}

export interface TerminalRunDecisionInvalidator {
  invalidateForTerminalRuns(where: TenantScoped<{ readonly issueId: string }>): Promise<number>;
}

/**
 * `IssueStateChanged` consumer (T077, contracts/evaluation.md "Events consumed"): outstanding
 * decisions bound to a run in a terminal state are invalidated (`run_terminal`). The event only
 * says *which issue moved*; whether a decision's run is terminal is read from `workflow_run`, a
 * structural fact, never from the event's payload — so a redelivered or reordered event is a
 * no-op rather than a wrong invalidation, and the tenant comes from the outbox record, not from a
 * request. No production caller subscribes it yet: this repository has no event dispatcher (the
 * same gap `releaseAbandonedCharges` carries); whoever builds one calls this per event.
 */
export function onIssueStateChanged(
  repo: TerminalRunDecisionInvalidator,
  event: IssueStateChangedEvent,
): Promise<number> {
  if (event.name !== 'IssueStateChanged') {
    throw new Error(`onIssueStateChanged was handed a ${event.name} event`);
  }
  const context = TenantContext.forTrustedInternalUse(event.tenantId);
  return repo.invalidateForTerminalRuns(scope(context, { issueId: event.subjectId }));
}
