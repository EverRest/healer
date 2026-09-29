import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import { PrismaPolicyActionRepository, SEED_POLICY_ACTIONS } from '@healer/domain-policy';
import { applySqlFile, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * `PrismaPolicyActionRepository` (002 T014, data-model.md `policy.policy_action`) — the action
 * registry. Global, not tenant-scoped (the one repository this batch writes with no
 * `TenantContext`, per data-model.md: "the set of actions the product can perform is a product
 * fact"). Seeded here with `SEED_POLICY_ACTIONS`, the exact same constant `scripts/db-seed.mjs`
 * mirrors for `make bootstrap` — this test is what proves the registry reads back what the
 * constant says, not what the bootstrap script happens to insert.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

describe('PrismaPolicyActionRepository (002 T014)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let repo: PrismaPolicyActionRepository;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    for (const action of SEED_POLICY_ACTIONS) {
      await prisma.policyAction.create({
        data: { ...action, introducedAt: new Date('2026-01-01T00:00:00Z') },
      });
    }
    repo = new PrismaPolicyActionRepository(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('finds change.open_pull_request as a mutating code_change action owned by 008', async () => {
    const action = await repo.findByKey('change.open_pull_request');
    expect(action).toMatchObject({
      actionKey: 'change.open_pull_request',
      actionClass: 'code_change',
      mutating: true,
      owningSpec: '008',
    });
  });

  it('finds deployment.rollback as a mutating reversible_remediation action owned by 010', async () => {
    const action = await repo.findByKey('deployment.rollback');
    expect(action).toMatchObject({
      actionKey: 'deployment.rollback',
      actionClass: 'reversible_remediation',
      mutating: true,
      owningSpec: '010',
    });
  });

  it('returns null for an unregistered action key, never throwing', async () => {
    expect(await repo.findByKey('deployment.forward_deploy')).toBeNull();
  });

  it('lists exactly the seeded registry, no more and no less', async () => {
    const actions = await repo.list();
    expect(actions.map((a) => a.actionKey).sort()).toEqual(
      SEED_POLICY_ACTIONS.map((a) => a.actionKey).sort(),
    );
  });
});
