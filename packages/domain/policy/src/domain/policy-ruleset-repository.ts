import type { TenantScoped } from '@healer/shared';
import type { ConflictWarning } from './conflict-warnings.js';
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
 *  write (digest, conflict warnings, the next monotone version). */
export interface NewPublishedRuleset {
  readonly id: string;
  readonly version: number;
  readonly digest: string;
  readonly publishedAt: Date;
  readonly publishedBy: string;
  readonly supersedesVersion?: number;
  readonly conflictWarnings: readonly ConflictWarning[];
  readonly rules: readonly RuleBody[];
}

/**
 * `policy_ruleset` / `policy_rule` (T019, data-model.md). Every method takes `TenantScoped`
 * (T015's pattern) — `policy_ruleset` is tenant-scoped, unlike `policy_action` (T014).
 */
export interface PolicyRulesetRepository {
  /** The published version with this exact digest for this tenant, or null — R-01's "identical
   *  content is a no-op" lookup. */
  findByDigest(where: TenantScoped<{ readonly digest: string }>): Promise<PublishedRuleset | null>;

  /** The current (highest-version) published ruleset for this tenant, or null when none has ever
   *  been published — contracts/evaluation.md step 1's "current published version for the
   *  tenant". */
  findLatest(where: TenantScoped<object>): Promise<PublishedRuleset | null>;

  /** Writes the ruleset, its rules and the audit entry naming both versions in one transaction
   *  (data-model.md: "the publish writes an audit_entry naming both versions — because the rule
   *  sets are immutable and addressable, that entry *is* the diff", FR-020), and publishes
   *  `PolicyRulesetPublished` through the outbox. */
  publish(where: TenantScoped<NewPublishedRuleset>): Promise<PublishedRuleset>;
}
