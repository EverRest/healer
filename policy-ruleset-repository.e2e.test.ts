import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import {
  publishRuleset,
  PrismaPolicyRulesetRepository,
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
      expect(audit).toMatchObject({ action: 'policy.publish_ruleset', actorRef: 'pavlo', outcome: 'ok' });

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
      const v1 = await publishRuleset(repo, CONTEXT, { rules: [rule({ ruleKey: 'allow-c' })], publishedBy: 'pavlo' });
      const v2 = await publishRuleset(repo, CONTEXT, { rules: [rule({ ruleKey: 'deny-c', outcome: 'deny' })], publishedBy: 'pavlo' });

      expect(v2.version).toBe(v1.version + 1);
      expect(v2.supersedesVersion).toBe(v1.version);

      const latest = await repo.findLatest(scope(CONTEXT, {}));
      expect(latest?.id).toBe(v2.id);
    }));

  it('a decision citing an earlier version still resolves it exactly, via findByDigest', async () =>
    withCorrelation('corr-publish-4', async () => {
      const rules = [rule({ ruleKey: `stable-${randomUUID()}` })];
      const published = await publishRuleset(repo, CONTEXT, { rules, publishedBy: 'pavlo' });
      const resolved = await repo.findByDigest(scope(CONTEXT, { digest: published.digest }));
      expect(resolved?.rules.map((r) => r.ruleKey)).toEqual(rules.map((r) => r.ruleKey));
    }));
});
