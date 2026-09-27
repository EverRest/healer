import type { TenantScoped } from '@healer/shared';
import type { Issue, IssueKind, IssueSeverity } from './issue.js';
import type { IssueEventCause } from './state-machine.js';

/**
 * What a caller supplies to create a new issue. Always starts in `detected` — the diagram's only
 * state with no incoming edge — and `occurrenceCount` starts at the database's own default (1),
 * not a caller-supplied value: counting matching signals is 001 T018's job, not this one's.
 */
export interface NewIssue {
  readonly id: string;
  readonly kind: IssueKind;
  readonly componentId?: string;
  readonly environment: string;
  readonly severity: IssueSeverity;
  readonly fingerprint: string;
  readonly rulesetVersion: number;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  /**
   * Set when this issue is a recurrence (001 T022, FR-005, FR-020): the id of the resolved issue
   * a matching signal arrived for outside the reopen window. `create` writes the `recurrence_of`
   * `issue_relationship` row in the same transaction as the issue itself — an issue created as a
   * recurrence with no relationship row is exactly the "prose guarantee, no mechanism" shape this
   * repository exists to make impossible.
   */
  readonly recurrenceOf?: string;
}

/**
 * Two concurrent *first* occurrences of a brand-new fingerprint both saw `findOpenByFingerprint`
 * return null and both called `create` (001 T026, reproduced under real load — up to
 * `QUEUE_CLASSES.ingestion.concurrency` issues for one fingerprint, not the "narrow" race it was
 * once assumed to be). `create` throws this instead of committing a second open issue for the
 * same fingerprint; the caller (`ingestSignal`) is the one place that knows the right response is
 * "someone else already created it — attach to theirs", not "this failed".
 */
export class FingerprintAlreadyOpenError extends Error {
  constructor(readonly fingerprint: string) {
    super(`an open issue for fingerprint ${fingerprint} already exists`);
    this.name = 'FingerprintAlreadyOpenError';
  }
}

/**
 * Create, read, transition and record-occurrence only (FR-006) — there is no generic update.
 * `transition` and `recordOccurrence` are the two legitimate mutations, and both always write
 * the `issue_event` that records what happened in the same operation: a state change or a signal
 * with no event is exactly the "prose guarantee, no mechanism" shape this repository exists to
 * make impossible (docs/patterns.md).
 */
export interface IssueRepository {
  create(issue: TenantScoped<NewIssue>): Promise<Issue>;
  findById(where: TenantScoped<{ readonly id: string }>): Promise<Issue | null>;
  /**
   * The same fingerprint lookup 001 T002's partial index exists for, narrowed to genuinely
   * *open* issues (FR-002's own words) — `resolved` excluded on purpose: whether a matching
   * signal reopens a resolved issue or starts a recurrence is 001 T022's decision (R-02), not
   * this method's to make by quietly attaching to one.
   */
  findOpenByFingerprint(
    where: TenantScoped<{ readonly fingerprint: string }>,
  ): Promise<Issue | null>;
  /**
   * The most recently resolved issue sharing this fingerprint, if any (001 T022, FR-005) — used
   * to decide whether a new matching signal reopens it (inside the configured window) or starts
   * a recurrence (outside it). A recurrence chain can leave more than one resolved issue with the
   * same fingerprint over time; ordered so only the most recent resolution is ever measured
   * against.
   */
  findMostRecentlyResolvedByFingerprint(
    where: TenantScoped<{ readonly fingerprint: string }>,
  ): Promise<Issue | null>;
  transition(
    where: TenantScoped<{ readonly id: string }>,
    to: Issue['state'],
    cause: IssueEventCause,
    actorRef: string,
  ): Promise<Issue>;
  /**
   * A matching signal attaching to an already-open issue (FR-002): `occurrenceCount` increments,
   * `lastSeenAt` advances to the later of the two (never backwards — out-of-order delivery must
   * not move it earlier), and an `issue_event` of type `signal_received` records it (FR-013's
   * timeline is a union over this table).
   */
  recordOccurrence(where: TenantScoped<{ readonly id: string }>, observedAt: Date): Promise<Issue>;
}
