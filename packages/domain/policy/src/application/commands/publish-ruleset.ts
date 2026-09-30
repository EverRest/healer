import { randomUUID } from 'node:crypto';
import { scope, type TenantContext } from '@healer/shared';
import { computeConflictWarnings } from '../../domain/conflict-warnings.js';
import {
  assertUniqueRuleKeys,
  assertValidPredicates,
  computeRulesetDigest,
  type RuleBody,
} from '../../domain/policy-ruleset.js';
import {
  StaleRulesetVersionError,
  type PolicyRulesetRepository,
  type PublishedRuleset,
} from '../../domain/policy-ruleset-repository.js';

/** The audit `action` a publish records (data-model.md: "the publish writes an audit_entry
 *  naming both versions — that entry *is* the diff", FR-020). */
export const PUBLISH_RULESET_AUDIT_ACTION = 'policy.publish_ruleset';

/** How many times a publish retries against a concurrent publish for the same tenant that took
 *  the version this attempt computed first (review finding). A placeholder bound, the same
 *  standing as `close-issue.ts`'s `MAX_CLOSE_ATTEMPTS` — ruleset publishes are rare and
 *  low-contention, so this is generous rather than tuned. */
const MAX_PUBLISH_ATTEMPTS = 5;

function auditReason(version: number, supersedesVersion: number | undefined): string {
  return supersedesVersion !== undefined
    ? `published version ${version}, superseding version ${supersedesVersion}`
    : `published version ${version}`;
}

/**
 * `PublishRuleset` (T019, data-model.md, FR-004, FR-006, R-01). Computes the digest and the
 * conflict warnings before the first write, and decides no-op vs. new version — but that
 * decision is a *snapshot*: another publish for this tenant can commit between the read here and
 * the write in `repo.publish()`. Two concurrent publishes racing to the same computed version is
 * handled by retrying with freshly read state (review finding — `repo.publish()` used to leave a
 * raw `PrismaClientKnownRequestError` (P2002) to propagate on the losing side); two concurrent
 * publishes of *identical* content resolve to the one row regardless of which caller's insert
 * actually landed, since `repo.publish()` itself now treats "digest already exists" as the no-op
 * it always was, not an error.
 *
 * Identical content (same digest) is a no-op: the existing published version is returned as-is,
 * with no new row and no new audit entry — republishing what already stands is not a change to
 * audit (R-01).
 *
 * Rejects a request with two rules sharing a `ruleKey` (`DuplicateRuleKeyError`, `VALIDATION`)
 * before computing anything or touching the repository — review finding: nothing upstream of
 * `policy_rule`'s own `@@unique([rulesetId, ruleKey])` constraint used to reject this, so such a
 * request reached the repository, hit that constraint as a P2002, and was indistinguishable from
 * a genuine version race, burning every retry attempt against a request that could never succeed.
 *
 * Also validates every predicate's shape (`assertValidPredicates`, `RulesetPredicateInvalidError`,
 * `VALIDATION` — batch 9 I2, review finding) before computing anything: an in-process publish (a
 * seed script, 011's future simulator) used to be able to store a rule set that makes `evaluate()`
 * throw, since the only check lived at the HTTP DTO edge. Same domain-layer validation the HTTP
 * boundary now reuses, not a second copy of it.
 */
export async function publishRuleset(
  repo: PolicyRulesetRepository,
  context: TenantContext,
  input: { readonly rules: readonly RuleBody[]; readonly publishedBy: string },
  now: () => Date = () => new Date(),
): Promise<PublishedRuleset> {
  assertUniqueRuleKeys(input.rules);
  assertValidPredicates(input.rules);
  const digest = computeRulesetDigest(input.rules);

  for (let attempt = 1; ; attempt += 1) {
    const existing = await repo.findByDigest(scope(context, { digest }));
    if (existing !== null) return existing;

    const latest = await repo.findLatest(scope(context, {}));
    const conflictWarnings = computeConflictWarnings(input.rules);
    const id = randomUUID();
    const version = (latest?.version ?? 0) + 1;
    const supersedesVersion = latest?.version;

    try {
      return await repo.publish(
        scope(context, {
          id,
          version,
          digest,
          publishedAt: now(),
          publishedBy: input.publishedBy,
          ...(supersedesVersion !== undefined ? { supersedesVersion } : {}),
          conflictWarnings,
          rules: input.rules,
          auditEntry: scope(context, {
            id: randomUUID(),
            actorType: 'human',
            actorRef: input.publishedBy,
            action: PUBLISH_RULESET_AUDIT_ACTION,
            targetType: 'policy_ruleset',
            targetId: id,
            reason: auditReason(version, supersedesVersion),
            evidenceIds: [],
            outcome: 'ok',
          }),
        }),
      );
    } catch (error) {
      if (error instanceof StaleRulesetVersionError && attempt < MAX_PUBLISH_ATTEMPTS) continue;
      throw error;
    }
  }
}
