import { z } from 'zod';
import { DETECTOR_KEYS } from './redaction-ruleset.js';

/**
 * The collection half of the boundary (003 T006, contracts/collection-plan.md): the closed lists
 * both planes name, the `collection_plan` directive and the structured `collection_gap`.
 *
 * Every closed list below has exactly one authority — here. The control plane's registry
 * (`@healer/domain-context`) and the runner's collectors are keyed on these arrays, and the
 * Postgres enums mirror them behind a test, so a collector that is not in `COLLECTOR_KEYS` is not
 * a string a model can put in a request, it is a value the schema cannot hold (R-12).
 */

const isoTimestamp = z.string().datetime({ offset: true });

/** Ceilings a directive cannot exceed — a number a model or a bug can name must still be bounded. */
export const MAX_WALL_CLOCK_MS = 600_000;
export const MAX_ITEMS_PER_COLLECTOR = 10_000;

/** The boundary schema version both planes record when they validate (012 FR-022). */
export const COLLECTION_CONTRACT_VERSION = 1;

/** The v1 collector set — the constitution's adapter table and nothing beyond it (spec assumptions). */
export const COLLECTOR_KEYS = [
  'loki_logs',
  'otel_traces',
  'prometheus_metrics',
  'grafana_alerts',
  'gitlab_commits',
  'gitlab_merge_requests',
  'gitlab_deployments',
  'config_flags',
  'source_file',
] as const;
export type CollectorKey = (typeof COLLECTOR_KEYS)[number];

/** What a collector may emit: members of 012's closed shape set, by `kind` — never a new shape (R-03). */
export const ITEM_CLASSES = [
  'error_signature',
  'stack_frame',
  'trace_shape',
  'metric_delta',
  'deploy_ref',
  'commit_ref',
  'test_result',
  'file_path',
  'pull_request_ref',
  'config_key_ref',
  'knowledge_ref',
  'tool_output_summary',
] as const;
export type ItemClass = (typeof ITEM_CLASSES)[number];

/** R-07: the closed reason-code set; `empty_result` is its own code, not a flavour of `unavailable`. */
export const GAP_REASON_CODES = [
  'source_unreachable',
  'auth_revoked',
  'timeout',
  'retention_exceeded',
  'capability_unavailable',
  'budget_exhausted',
  'redaction_withheld',
  'schema_rejected',
  'empty_result',
] as const;
export type GapReasonCode = (typeof GAP_REASON_CODES)[number];

/** FR-014. */
export const SOURCE_STATUSES = [
  'collected',
  'partial',
  'unavailable',
  'timed_out',
  'withheld',
  'not_attempted',
] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

/** FR-005: a follow-up pass carries an enumerated reason, never prose. */
export const FOLLOW_UP_REASONS = [
  'inspect_stack_frame_source',
  'widen_time_window',
  'probe_missing_source',
] as const;
export type FollowUpReason = (typeof FOLLOW_UP_REASONS)[number];

/** Collectors reachable only as a follow-up pass, so they inherit its cap, validation and audit (R-12). */
export const FOLLOW_UP_ONLY_COLLECTORS: readonly CollectorKey[] = ['source_file'];

// ─────────────────────────── collector parameters ───────────────────────────
// The control plane never sends a query, an expression or a command — only declared fields.

// A label, never a query: no selector syntax, no whitespace, bounded. These reach a customer system's
// own client as trusted values, so the schema is the last place an expression can be refused.
const label = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/);
const scoped = z.object({ component: label, environment: label }).strict();

/** Repository-relative: no absolute path, no `..`, no backslash (R-05a — the control plane narrows further). */
export const repoRelativePath = z
  .string()
  .regex(/^[\w@$.+/-]{1,300}$/)
  .refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), 'repository-relative only');

/** The one authority for each collector's parameter schema (validated at egress and ingress alike). */
export const COLLECTOR_PARAMETER_SCHEMAS = {
  loki_logs: scoped,
  otel_traces: scoped,
  prometheus_metrics: scoped,
  grafana_alerts: scoped,
  gitlab_commits: scoped,
  gitlab_merge_requests: scoped,
  gitlab_deployments: scoped,
  config_flags: scoped,
  source_file: z.object({ paths: z.array(repoRelativePath).min(1).max(20) }).strict(),
} as const satisfies Record<CollectorKey, z.ZodTypeAny>;

function collectorRequest<K extends CollectorKey>(key: K) {
  return z
    .object({
      collectorKey: z.literal(key),
      parameters: COLLECTOR_PARAMETER_SCHEMAS[key],
      timeoutMs: z.number().int().positive(),
      itemClasses: z.array(z.enum(ITEM_CLASSES)).min(1),
    })
    .strict();
}

export const CollectorRequest = z.discriminatedUnion('collectorKey', [
  collectorRequest('loki_logs'),
  collectorRequest('otel_traces'),
  collectorRequest('prometheus_metrics'),
  collectorRequest('grafana_alerts'),
  collectorRequest('gitlab_commits'),
  collectorRequest('gitlab_merge_requests'),
  collectorRequest('gitlab_deployments'),
  collectorRequest('config_flags'),
  collectorRequest('source_file'),
]);
export type CollectorRequest = z.infer<typeof CollectorRequest>;

// ─────────────────────────── control plane → runner ───────────────────────────

/**
 * The `collection_plan` directive (contracts/collection-plan.md). A plain object so it can be a
 * member of `ControlPlaneDirective`'s discriminated union; the cross-field rules live in
 * `checkCollectionPlan`, which that union applies after parsing.
 */
export const collectionPlan = z
  .object({
    kind: z.literal('collection_plan'),
    passId: z.string().uuid(),
    issueRef: z.string().uuid(),
    planDigest: z.string().min(1),
    passOrdinal: z.number().int().nonnegative(),
    contractVersion: z.number().int().positive(),
    window: z.object({ from: isoTimestamp, to: isoTimestamp }).strict(),
    collectors: z.array(CollectorRequest).min(1).max(COLLECTOR_KEYS.length),
    budget: z
      .object({
        maxWallClockMs: z.number().int().positive().max(MAX_WALL_CLOCK_MS),
        maxItemsPerCollector: z.number().int().positive().max(MAX_ITEMS_PER_COLLECTOR),
      })
      .strict(),
    redactionRulesetVersion: z.number().int().positive(),
    requestedByStep: z.string().min(1).optional(),
    requestReason: z.enum(FOLLOW_UP_REASONS).optional(),
  })
  .strict();
export type CollectionPlanDirective = z.infer<typeof collectionPlan>;

/**
 * Pass 0 names no follow-up-only collector and no requester; a follow-up (ordinal > 0) names both —
 * the "who asked and why" attribution of FR-005 is a property of the shape, not of a caller's care.
 */
export function checkCollectionPlan(plan: CollectionPlanDirective, ctx: z.RefinementCtx): void {
  const followUp = plan.passOrdinal > 0;
  // Each of the pair is present exactly when this is a follow-up — pass 0 names neither one.
  if (
    (plan.requestedByStep !== undefined) !== followUp ||
    (plan.requestReason !== undefined) !== followUp
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['requestedByStep'],
      message: 'a follow-up pass names its requester and reason; pass 0 names neither',
    });
  }
  if (
    !followUp &&
    plan.collectors.some((c) => FOLLOW_UP_ONLY_COLLECTORS.includes(c.collectorKey))
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['collectors'],
      message: 'a follow-up-only collector is not reachable from pass 0',
    });
  }
  if (new Set(plan.collectors.map((c) => c.collectorKey)).size !== plan.collectors.length) {
    ctx.addIssue({ code: 'custom', path: ['collectors'], message: 'a collector is named once' });
  }
  if (Date.parse(plan.window.from) >= Date.parse(plan.window.to)) {
    ctx.addIssue({ code: 'custom', path: ['window'], message: 'the window runs forward' });
  }
}

// ─────────────────────────── runner → control plane: collection_gap ───────────────────────────

/**
 * 012's `collection_gap` (what / why / withheldByRedaction), widened with the structured fields
 * 003's gaps carry (contracts/collection-plan.md "Withheld items"). Every added field is an enum,
 * an id, a count or a timestamp: nothing a withheld item contained can ride in it, and `localRef`
 * is a UUID the control plane is structurally unable to dereference (R-08).
 */
export const collectionGap = z
  .object({
    kind: z.literal('collection_gap'),
    what: z.string(),
    why: z.string(),
    withheldByRedaction: z.boolean(),
    collectorKey: z.enum(COLLECTOR_KEYS).optional(),
    reasonCode: z.enum(GAP_REASON_CODES).optional(),
    /** The detector that could not clear the item — named, so a gap is diagnosable (R-07a). */
    detector: z.enum(DETECTOR_KEYS).optional(),
    itemClass: z.enum(ITEM_CLASSES).optional(),
    localRef: z.string().uuid().optional(),
    observedAt: isoTimestamp.optional(),
    attemptDurationMs: z.number().int().nonnegative().optional(),
    itemCount: z.number().int().nonnegative().optional(),
  })
  .strict();
