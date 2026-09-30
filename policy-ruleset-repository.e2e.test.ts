import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import {
  publishRuleset,
  PrismaPolicyRulesetRepository,
  StaleRulesetVersionError,
  type RuleBody,
} from '@healer/domain-policy';
import { scope, TenantContext, withCorrelation } from '@healer/shared';
import { applySqlFile, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * `PrismaPolicyRulesetRepository` (T019, data-model.md `policy.policy_ruleset` /
 * `policy.policy_rule`) against a real Postgres: `publishRuleset` writing the ruleset, its rules,
 * the audit entry naming both versions (T017's guarantee, its first real caller) and the
 * `PolicyRulesetPublished` outbox event all in one transaction; the digest no-op on republish;
 * monotone versioning across two publishes for the same tenant.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-8000-0000000000f5';
const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);

function rule(overrides: Partial<RuleBody>): RuleBody {
  return {
    ruleKey: 'r',
    predicates: [],
    outcome: 'allow',
    reasonCode: 'NO_ADOPTED_EXPECTATION',
    note: '',
    ...overrides,
  };
}

describe('PrismaPolicyRulesetRepository (002 T019)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let repo: PrismaPolicyRulesetRepository;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    repo = new PrismaPolicyRulesetRepository(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('publishes version 1, writing the ruleset, its rules and an audit entry in one transaction', async () =>
    withCorrelation('corr-publish-1', async () => {
      const rules = [rule({ ruleKey: 'allow-a' })];
      const published = await publishRuleset(repo, CONTEXT, { rules, publishedBy: 'pavlo' });

      expect(published.version).toBe(1);
      expect(published.supersedesVersion).toBeUndefined();
      expect(published.rules).toHaveLength(1);

      const audit = await prisma.auditEntry.findFirst({
        where: { tenantId: TENANT_ID, targetType: 'policy_ruleset', targetId: published.id },
      });
      expect(audit).toMatchObject({
        action: 'policy.publish_ruleset',
        actorRef: 'pavlo',
        outcome: 'ok',
      });
      // 002 T033 (scoped this run to PublishRuleset's own entry): exactly one audit entry per
      // publish, naming the actor and — for the first version — that there is no "before".
      expect(
        await prisma.auditEntry.count({ where: { tenantId: TENANT_ID, targetId: published.id } }),
      ).toBe(1);
      expect(audit?.reason).toBe(`published version ${published.version}`);

      const outboxRow = await prisma.outbox.findFirst({
        where: { tenantId: TENANT_ID, name: 'PolicyRulesetPublished', subjectId: published.id },
      });
      expect(outboxRow).not.toBeNull();
      expect(outboxRow?.payload).toMatchObject({ version: 1, digest: published.digest });
    }));

  it('republishing identical content is a no-op: same version, no new row, no new audit entry', async () =>
    withCorrelation('corr-publish-2', async () => {
      const rules = [rule({ ruleKey: 'allow-b' })];
      const first = await publishRuleset(repo, CONTEXT, { rules, publishedBy: 'pavlo' });
      const countBefore = await prisma.policyRuleset.count({ where: { tenantId: TENANT_ID } });

      const second = await publishRuleset(repo, CONTEXT, { rules, publishedBy: 'someone-else' });
      const countAfter = await prisma.policyRuleset.count({ where: { tenantId: TENANT_ID } });

      expect(second.id).toBe(first.id);
      expect(second.publishedBy).toBe('pavlo');
      expect(countAfter).toBe(countBefore);
    }));

  it('changed content creates a new, monotone version citing the one it supersedes', async () =>
    withCorrelation('corr-publish-3', async () => {
      const v1 = await publishRuleset(repo, CONTEXT, {
        rules: [rule({ ruleKey: 'allow-c' })],
        publishedBy: 'pavlo',
      });
      const v2 = await publishRuleset(repo, CONTEXT, {
        rules: [rule({ ruleKey: 'deny-c', outcome: 'deny' })],
        publishedBy: 'pavlo',
      });

      expect(v2.version).toBe(v1.version + 1);
      expect(v2.supersedesVersion).toBe(v1.version);

      const latest = await repo.findLatest(scope(CONTEXT, {}));
      expect(latest?.id).toBe(v2.id);

      // 002 T033 (scoped this run): the audit entry naming a superseding publish's before/after
      // versions — `PublishRuleset`'s own `auditReason`, unasserted until now.
      const audit = await prisma.auditEntry.findFirst({
        where: { tenantId: TENANT_ID, targetType: 'policy_ruleset', targetId: v2.id },
      });
      expect(audit?.reason).toBe(
        `published version ${v2.version}, superseding version ${v1.version}`,
      );
    }));

  it('a decision citing an earlier version still resolves it exactly, via findByDigest', async () =>
    withCorrelation('corr-publish-4', async () => {
      const rules = [rule({ ruleKey: `stable-${randomUUID()}` })];
      const published = await publishRuleset(repo, CONTEXT, { rules, publishedBy: 'pavlo' });
      const resolved = await repo.findByDigest(scope(CONTEXT, { digest: published.digest }));
      expect(resolved?.rules.map((r) => r.ruleKey)).toEqual(rules.map((r) => r.ruleKey));
    }));

  it('findByVersion resolves a superseded version forever, and a version never published as null (SC-003)', async () =>
    withCorrelation('corr-publish-version-lookup', async () => {
      const tenant = TenantContext.forTrustedInternalUse('00000000-0000-0000-8000-0000000000fa');
      const v1 = await publishRuleset(repo, tenant, {
        rules: [rule({ ruleKey: 'v1' })],
        publishedBy: 'pavlo',
      });
      const v2 = await publishRuleset(repo, tenant, {
        rules: [rule({ ruleKey: 'v2', outcome: 'deny' })],
        publishedBy: 'pavlo',
      });

      const resolvedV1 = await repo.findByVersion(scope(tenant, { version: v1.version }));
      expect(resolvedV1?.id).toBe(v1.id);
      expect(resolvedV1?.rules.map((r) => r.ruleKey)).toEqual(['v1']);

      const resolvedV2 = await repo.findByVersion(scope(tenant, { version: v2.version }));
      expect(resolvedV2?.id).toBe(v2.id);

      expect(await repo.findByVersion(scope(tenant, { version: 9999 }))).toBeNull();
    }));

  it("list returns every published version for this tenant, newest first, and never another tenant's", async () =>
    withCorrelation('corr-publish-list', async () => {
      const tenant = TenantContext.forTrustedInternalUse('00000000-0000-0000-8000-0000000000fb');
      const other = TenantContext.forTrustedInternalUse('00000000-0000-0000-8000-0000000000fc');
      const v1 = await publishRuleset(repo, tenant, {
        rules: [rule({ ruleKey: 'list-v1' })],
        publishedBy: 'pavlo',
      });
      const v2 = await publishRuleset(repo, tenant, {
        rules: [rule({ ruleKey: 'list-v2', outcome: 'deny' })],
        publishedBy: 'pavlo',
      });
      await publishRuleset(repo, other, {
        rules: [rule({ ruleKey: 'other-tenant' })],
        publishedBy: 'pavlo',
      });

      const list = await repo.list(scope(tenant, {}));
      expect(list.map((r) => r.id)).toEqual([v2.id, v1.id]);
    }));

  // Review finding: `publishRuleset` used to read-decide-write with no lock, so two concurrent
  // publishes for the same tenant could both compute the same next version and race a raw
  // `PrismaClientKnownRequestError` (P2002) to the loser. Fixed by having `repo.publish()`
  // resolve a digest collision as the no-op it always was, and retry-on-conflict (via
  // `StaleRulesetVersionError`) for a genuine version collision — proved here against real
  // concurrent writes, the same way the existing `consumeDecision` race test proves its own lock.
  describe('concurrent publishes for the same tenant (review finding)', () => {
    const CONCURRENT_TENANT = TenantContext.forTrustedInternalUse(
      '00000000-0000-0000-8000-0000000000f8',
    );

    it('two concurrent publishes of different content both succeed, with distinct consecutive versions — no raw Prisma error', async () =>
      withCorrelation('corr-publish-race-1', async () => {
        const [a, b] = await Promise.all([
          publishRuleset(repo, CONCURRENT_TENANT, {
            rules: [rule({ ruleKey: `race-a-${randomUUID()}` })],
            publishedBy: 'pavlo',
          }),
          publishRuleset(repo, CONCURRENT_TENANT, {
            rules: [rule({ ruleKey: `race-b-${randomUUID()}` })],
            publishedBy: 'pavlo',
          }),
        ]);

        expect(a.digest).not.toBe(b.digest);
        expect(new Set([a.version, b.version]).size).toBe(2);
        expect(Math.max(a.version, b.version) - Math.min(a.version, b.version)).toBe(1);

        const latest = await repo.findLatest(scope(CONCURRENT_TENANT, {}));
        expect(latest?.version).toBe(Math.max(a.version, b.version));
      }));

    it('two concurrent publishes of identical content both resolve to the one row — no duplicate version', async () =>
      withCorrelation('corr-publish-race-2', async () => {
        const rules = [rule({ ruleKey: `race-same-${randomUUID()}` })];
        const [a, b] = await Promise.all([
          publishRuleset(repo, CONCURRENT_TENANT, { rules, publishedBy: 'pavlo' }),
          publishRuleset(repo, CONCURRENT_TENANT, { rules, publishedBy: 'someone-else' }),
        ]);

        expect(a.id).toBe(b.id);
        expect(a.version).toBe(b.version);

        const rowCount = await prisma.policyRuleset.count({
          where: { tenantId: CONCURRENT_TENANT.tenantId, digest: a.digest },
        });
        expect(rowCount).toBe(1);
      }));
  });

  // Review finding: the repository's P2002 handling used to catch *any* unique violation from
  // this transaction, including `policy_rule`'s own `@@unique([rulesetId, ruleKey])` constraint —
  // reached when two rules share a `ruleKey` — and misdiagnosed it as `StaleRulesetVersionError`.
  // `publishRuleset` now rejects that case before ever calling the repository
  // (`assertUniqueRuleKeys`), but the repository is exercised directly here too: enforcing the
  // narrowed catch at this layer independently is what keeps a *second* caller of `publish()`
  // that skipped the application-layer guard from hitting the same misdiagnosis.
  it('publish() lets a policy_rule ruleKey collision propagate as a raw P2002, not StaleRulesetVersionError', async () =>
    withCorrelation('corr-publish-rulekey-collision', async () => {
      const tenant = TenantContext.forTrustedInternalUse('00000000-0000-0000-8000-0000000000f9');
      const duplicateKey = `dup-${randomUUID()}`;

      const attempt = repo.publish(
        scope(tenant, {
          id: randomUUID(),
          version: 1,
          digest: `digest-${randomUUID()}`,
          publishedAt: new Date(),
          publishedBy: 'pavlo',
          conflictWarnings: [],
          rules: [
            rule({ ruleKey: duplicateKey }),
            rule({ ruleKey: duplicateKey, outcome: 'deny' }),
          ],
          auditEntry: scope(tenant, {
            id: randomUUID(),
            actorType: 'human' as const,
            actorRef: 'pavlo',
            action: 'policy.publish_ruleset',
            targetType: 'policy_ruleset',
            targetId: randomUUID(),
            reason: 'test: rulekey collision',
            evidenceIds: [],
            outcome: 'ok',
          }),
        }),
      );

      await expect(attempt).rejects.toThrow(/Unique constraint/);
      await expect(attempt).rejects.not.toBeInstanceOf(StaleRulesetVersionError);

      // No ruleset row was left behind — the transaction rolled back as a whole, and this was
      // never resolved (incorrectly) to an existing row the way a genuine digest race would be.
      const rows = await prisma.policyRuleset.count({ where: { tenantId: tenant.tenantId } });
      expect(rows).toBe(0);
    }));
});
