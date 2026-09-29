// Mirrors 001's `issue.issue_kind` and `issue.issue_state` enums (prisma/schema.prisma) as plain
// string unions, for the same reason `action-class.ts` mirrors this package's own: domain code
// cannot import `@prisma/client`, and a cross-module domain import would couple this package to
// 001's package boundary instead of to the shared schema fact both already depend on.
export const ISSUE_KINDS = [
  'production_incident',
  'user_report',
  'monitoring_alert',
  'regression',
  'automated_detection',
  'knowledge_drift',
] as const;

export type IssueKind = (typeof ISSUE_KINDS)[number];

export const ISSUE_STATES = [
  'detected',
  'investigating',
  'diagnosed',
  'acting',
  'resolved',
  'needs_human',
  'stale',
  'merged',
  'removed',
] as const;

export type IssueState = (typeof ISSUE_STATES)[number];
