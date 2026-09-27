import type { TenantScoped } from '@healer/shared';
import type { IssueEventCause } from './state-machine.js';

/** Which of the three tables an entry came from — they have different grains (C-14). */
export type TimelineSource = 'issue_event' | 'workflow_transition' | 'evidence';

/**
 * One row of the timeline (001 T046, FR-013). `at` is the *observed* time (R-10): a provider clock
 * five minutes ahead moves the entry, it does not reorder the sequence around it. `summary` is
 * built from structured fields only — never from an excerpt or a payload — so nothing free-form
 * from a customer reaches this view, and no model wrote it.
 */
export interface TimelineEntry {
  readonly source: TimelineSource;
  readonly id: string;
  readonly at: Date;
  readonly type: string;
  readonly cause: IssueEventCause;
  readonly actorRef: string | null;
  readonly summary: string;
  readonly evidenceIds: readonly string[];
}

/**
 * A union query over `issue_event`, `workflow_transition` and `evidence` — nothing is copied
 * between them (data-model.md, 012 C-14). Total order `(at, source, id)`: rendering the same
 * records twice is byte-identical (SC-005), including entries that share a timestamp.
 */
export interface TimelineRepository {
  forIssue(where: TenantScoped<{ readonly issueId: string }>): Promise<readonly TimelineEntry[]>;
}
