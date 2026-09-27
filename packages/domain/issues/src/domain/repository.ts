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
}

/**
 * Create, read and transition only (FR-006) — there is no generic update. `transition` is the
 * one legitimate mutation of `state`, and it always writes the `issue_event` that records the
 * cause in the same operation: a state change with no event is exactly the "prose guarantee, no
 * mechanism" shape this repository exists to make impossible (docs/patterns.md).
 */
export interface IssueRepository {
  create(issue: TenantScoped<NewIssue>): Promise<Issue>;
  findById(where: TenantScoped<{ readonly id: string }>): Promise<Issue | null>;
  transition(
    where: TenantScoped<{ readonly id: string }>,
    to: Issue['state'],
    cause: IssueEventCause,
    actorRef: string,
  ): Promise<Issue>;
}
