import { randomUUID } from 'node:crypto';
import { scope, type TenantContext } from '@healer/shared';
import { computeConflictWarnings } from '../../domain/conflict-warnings.js';
import { computeRulesetDigest, type RuleBody } from '../../domain/policy-ruleset.js';
import type { PolicyRulesetRepository, PublishedRuleset } from '../../domain/policy-ruleset-repository.js';

/**
 * `PublishRuleset` (T019, data-model.md, FR-004, FR-006, R-01). Thin, same shape as
 * `mergeIssues`/`closeIssue` — the guarantees (immutability, the audit entry naming both
 * versions, the outbox publish) live in the repository's transaction; this is what computes the
 * digest and the conflict warnings *before* the first write, and decides no-op vs. new version.
 *
 * Identical content (same digest) is a no-op: the existing published version is returned as-is,
 * with no new row and no new audit entry — republishing what already stands is not a change to
 * audit (R-01).
 */
export async function publishRuleset(
  repo: PolicyRulesetRepository,
  context: TenantContext,
  input: { readonly rules: readonly RuleBody[]; readonly publishedBy: string },
  now: () => Date = () => new Date(),
): Promise<PublishedRuleset> {
  const digest = computeRulesetDigest(input.rules);
  const existing = await repo.findByDigest(scope(context, { digest }));
  if (existing !== null) return existing;

  const latest = await repo.findLatest(scope(context, {}));
  const conflictWarnings = computeConflictWarnings(input.rules);

  return repo.publish(
    scope(context, {
      id: randomUUID(),
      version: (latest?.version ?? 0) + 1,
      digest,
      publishedAt: now(),
      publishedBy: input.publishedBy,
      ...(latest !== null ? { supersedesVersion: latest.version } : {}),
      conflictWarnings,
      rules: input.rules,
    }),
  );
}
