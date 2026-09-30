import type { TenantScoped } from '@healer/shared';
import type { ConflictWarning } from './conflict-warnings.js';
import type { NewAuditEntry } from './audit-entry.js';
import type { RuleBody } from './policy-ruleset.js';

/** A published `policy_ruleset` row plus its rules, as `PublishRuleset` and its repository read
 *  and write it (data-model.md `policy.policy_ruleset` / `policy.policy_rule`). */
export interface PublishedRuleset {
  readonly id: string;
  readonly version: number;
  readonly digest: string;
  readonly publishedAt: Date;
  readonly publishedBy: string;
  readonly supersedesVersion?: number;
  readonly conflictWarnings: readonly ConflictWarning[];
  readonly rules: readonly RuleBody[];
}

/** What `publish()` writes — everything `PublishRuleset` has already computed before the first
 *  write attempt (digest, conflict warnings, the next monotone version it *believes* is free, and
 *  the audit entry naming both versions — built by the application command via `scope(context,
 *  ...)`, since it holds the real `TenantContext` and the repository never does; review finding).
 *  `version`/`supersedesVersion` are a snapshot, not a guarantee: a concurrent publish for the
 *  same tenant can have taken that version first, in which case `publish()` throws
 *  `StaleRulesetVersionError` for the caller to recompute and retry (review finding — see
 *  `publishRuleset`'s retry loop). */
export interface NewPublishedRuleset {
  readonly id: string;
  readonly version: number;
  readonly digest: string;
  readonly publishedAt: Date;
  readonly publishedBy: string;
  readonly supersedesVersion?: number;
  readonly conflictWarnings: readonly ConflictWarning[];
  readonly rules: readonly RuleBody[];
  readonly auditEntry: TenantScoped<NewAuditEntry>;
}

/**
 * Thrown by `publish()` when the `(tenantId, version)` this call attempted is no longer free — a
 * concurrent publish for the same tenant committed first. Distinct from "identical content already
 * published" (`publish()` resolves that case itself, returning the existing row, since it is a
 * real no-op regardless of which of two racing callers happened to write it — R-01). The caller
 * re-reads the tenant's current state and retries with a freshly computed version.
 */
export class StaleRulesetVersionError extends Error {
  constructor(
    readonly tenantId: string,
    readonly attemptedVersion: number,
  ) {
    super(
      `policy_ruleset version ${attemptedVersion} for tenant ${tenantId} was taken by a concurrent publish`,
    );
    this.name = 'StaleRulesetVersionError';
  }
}

/**
 * `policy_ruleset` / `policy_rule`, read side only (T019, data-model.md; split out for T024/T026 —
 * `ExplainDecision` depends on this and nothing wider, so a repository interface with a `publish`
 * method is never in its reachable type at all, not merely unused by its code). Every method takes
 * `TenantScoped` (T015's pattern) — `policy_ruleset` is tenant-scoped, unlike `policy_action` (T014).
 */
export interface ReadOnlyPolicyRulesetRepository {
  /** The published version with this exact digest for this tenant, or null — R-01's "identical
   *  content is a no-op" lookup. */
  findByDigest(where: TenantScoped<{ readonly digest: string }>): Promise<PublishedRuleset | null>;

  /** The current (highest-version) published ruleset for this tenant, or null when none has ever
   *  been published — contracts/evaluation.md step 1's "current published version for the
   *  tenant". */
  findLatest(where: TenantScoped<object>): Promise<PublishedRuleset | null>;

  /** One exact version for this tenant, or null — including a version superseded long ago: "a
   *  version cited by a decision resolves forever" (SC-003). Immutable rows, so this is a plain
   *  point lookup, never a snapshot of something that could still change under the caller. */
  findByVersion(
    where: TenantScoped<{ readonly version: number }>,
  ): Promise<PublishedRuleset | null>;

  /** Every published version for this tenant, newest first (`GET /policy/rulesets`, FR-004). */
  list(where: TenantScoped<object>): Promise<readonly PublishedRuleset[]>;
}

/**
 * `policy_ruleset` / `policy_rule` (T019, data-model.md), read and write. `PublishRuleset` depends
 * on this; `EvaluateAndBind` and `ExplainDecision` only ever need `ReadOnlyPolicyRulesetRepository`
 * above.
 */
export interface PolicyRulesetRepository extends ReadOnlyPolicyRulesetRepository {
  /**
   * Writes the ruleset, its rules and the audit entry naming both versions in one transaction
   * (data-model.md: "the publish writes an audit_entry naming both versions — because the rule
   * sets are immutable and addressable, that entry *is* the diff", FR-020), and publishes
   * `PolicyRulesetPublished` through the outbox.
   *
   * Concurrency (review finding): if another publish for this tenant committed the exact same
   * `digest` first, this resolves to that existing row rather than throwing — a real no-op no
   * matter which caller's insert actually landed. If another publish took `version` first with
   * *different* content, this throws `StaleRulesetVersionError` for the caller to retry.
   */
  publish(where: TenantScoped<NewPublishedRuleset>): Promise<PublishedRuleset>;
}
