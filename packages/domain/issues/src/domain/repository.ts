import type { TenantScoped } from '@healer/shared';
import type { Issue, IssueKind, IssueRelationship, IssueSeverity } from './issue.js';
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
 * An issue the staleness sweep may mark (001 T051, FR-017): the issue itself plus the progress time
 * the query measured it against — `lastProgressAt` is the later of its last signal and its last
 * state change, and it is what `IssueStale` carries (contracts/events.md). It is returned rather
 * than recomputed by the caller so the value published is the one the decision was made on.
 */
export interface StaleCandidate {
  readonly issue: Issue;
  readonly lastProgressAt: Date;
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
  /**
   * Deterministic correlation candidates (001 T039, FR-020): open issues sharing `componentId`
   * and `environment`, first seen inside `[since, until]`, excluding the subject issue itself.
   * A pre-filter, not the final say — `correlates()` (domain/correlation.ts) is still run on each
   * candidate the caller receives, the same "query narrows, pure function decides" split every
   * other repository method in this file already uses.
   */
  findOpenCorrelationCandidates(
    where: TenantScoped<{
      readonly componentId: string;
      readonly environment: string;
      readonly excludeId: string;
      readonly since: Date;
      readonly until: Date;
    }>,
  ): Promise<readonly Issue[]>;
  /**
   * Records a `related` relationship between two issues (001 T039, FR-020) — idempotent
   * regardless of which side calls first: `related` is symmetric, so the implementation stores
   * the pair in a canonical order before writing, and a second call naming the identical pair in
   * either direction returns `null` rather than a duplicate row or an error. Backed by the same
   * unique index `create`'s `recurrenceOf` path already relies on
   * (`issue_relationship_tenant_id_issue_id_other_kind_key`), which is itself directional — the
   * canonical ordering is what makes this method's own idempotency hold regardless of argument
   * order (review finding: without it, A-correlates-B and B-correlates-A each pass the index's
   * uniqueness check and insert a second row for the same fact). Never touches either issue's state.
   */
  correlate(
    where: TenantScoped<{ readonly id: string; readonly otherId: string; readonly rule: string }>,
  ): Promise<IssueRelationship | null>;
  /** `GET /issues` (001 T040): every filter is optional and narrows further, never widens. */
  list(
    where: TenantScoped<{
      readonly state?: Issue['state'];
      readonly componentId?: string;
      readonly since?: Date;
    }>,
  ): Promise<readonly Issue[]>;
  /**
   * Issues with neither a new signal nor a state change since `idleBefore` (001 T051, FR-017,
   * R-11). Only genuinely live states are considered: `resolved`, `merged`, `removed` and
   * already-`stale` issues are excluded, so the sweep is idempotent and never touches history.
   * "No progress" counts state changes as well as signals — an issue being actively worked on
   * with no new occurrences is not stale, which is why this cannot be a `last_seen_at` filter.
   */
  findStaleCandidates(
    where: TenantScoped<{ readonly idleBefore: Date }>,
  ): Promise<readonly StaleCandidate[]>;
  /**
   * Marks one issue stale (001 T051, FR-017, R-11): sets `state` and `staleAt`, writes the
   * `issue_event` recording it and publishes `IssueStale` — all in one transaction, the same
   * shape `transition` uses. Deliberately its own method rather than a `transition` call: a
   * staleness sweep that can reach the general transition API is a sweep that can resolve an
   * issue, and "stale is surfaced, never auto-resolved" is the whole of R-11. `at` is passed in
   * rather than taken from the clock inside so the sweep's own run time is what every issue it
   * marks records.
   */
  markStale(
    where: TenantScoped<{
      readonly id: string;
      readonly at: Date;
      readonly lastProgressAt: Date;
    }>,
  ): Promise<Issue>;
  /**
   * Every non-removed relationship touching this issue, in *either* direction (001 T040, FR-020):
   * `recurrence_of`/`merged_into` are written with this issue as the subject (`issueId`), while a
   * `related` correlation may name this issue as either side — the caller (the pure
   * `projectIssueRelationships`, domain/issue.ts) is what tells the two apart, not this query.
   */
  findRelationships(
    where: TenantScoped<{ readonly id: string }>,
  ): Promise<readonly IssueRelationship[]>;
}
