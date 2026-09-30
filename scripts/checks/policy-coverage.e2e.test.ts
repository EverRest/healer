import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publishRuleset, PrismaPolicyRulesetRepository } from '@healer/domain-policy';
import { TenantContext, newCorrelationId, withCorrelation } from '@healer/shared';
import { PrismaClient } from '../../prisma/generated/client/index.js';
import { applySqlFile, query, startPostgres, type StartedPostgres } from '../../test/containers.js';
import { findUncoveredMutatingActions } from './policy-coverage.mjs';

/**
 * `check:policy-coverage`'s real, live-database query (002 T031, SC-001, R-14), proven against a
 * real Postgres. Matches a decision via `audit_entry.policy_decision_id` (not a target-ref/target-
 * id cast — review finding, see policy-coverage.mjs's own header) and treats an `audit_entry`
 * whose `action` has no matching `policy_action` row as its own violation category (review
 * finding: an INNER join there would silently drop exactly the bypass this check exists to catch).
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-8000-0000000000f1';
const TARGET_COVERED = '00000000-0000-0000-8000-0000000000f2';
const TARGET_UNCOVERED = '00000000-0000-0000-8000-0000000000f3';
const TARGET_READ_ONLY = '00000000-0000-0000-8000-0000000000f4';
const TARGET_UNREGISTERED = '00000000-0000-0000-8000-0000000000f9';
const TARGET_WRONG_ACTION = '00000000-0000-0000-8000-0000000000fc';
const DECISION_ID = '00000000-0000-0000-8000-0000000000f5';

describe('check:policy-coverage against a real Postgres (002 T031, SC-001, R-14)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }

    await query(
      pg,
      `insert into "policy"."policy_action" (action_key, action_class, mutating, owning_spec, introduced_at)
       values
         ('change.open_pull_request', 'code_change', true, '008', now()),
         ('issue.view', 'read_only', false, '001', now()),
         ('policy.publish_ruleset', 'read_only', false, '002', now()),
         ('deployment.rollback', 'reversible_remediation', true, '010', now())`,
    );

    // Covered: a mutating action linked, via policy_decision_id, to a consumed ALLOW decision.
    await query(
      pg,
      `insert into "policy"."policy_decision"
         (id, tenant_id, action_key, target_ref, proposal_digest, decision_input, ruleset_version,
          outcome, ceiling_applied, budget_state, evaluated_at, consumed_at)
       values
         ('${DECISION_ID}', '${TENANT_ID}', 'change.open_pull_request', '${TARGET_COVERED}',
          'digest-1', '{}', 1, 'allow', false, '{}', now(), now())`,
    );

    await query(
      pg,
      `insert into "audit"."audit_entry"
         (id, tenant_id, actor_type, actor_ref, action, target_type, target_id, reason,
          evidence_ids, outcome, policy_decision_id)
       values
         ('00000000-0000-0000-8000-0000000000f6', '${TENANT_ID}', 'human', 'pavlo',
          'change.open_pull_request', 'issue', '${TARGET_COVERED}', 'opened fix pr', '{}', 'ok',
          '${DECISION_ID}'),
         ('00000000-0000-0000-8000-0000000000f7', '${TENANT_ID}', 'human', 'pavlo',
          'change.open_pull_request', 'issue', '${TARGET_UNCOVERED}', 'opened fix pr', '{}', 'ok',
          null),
         ('00000000-0000-0000-8000-0000000000f8', '${TENANT_ID}', 'human', 'pavlo',
          'issue.view', 'issue', '${TARGET_READ_ONLY}', 'viewed issue', '{}', 'ok', null),
         ('00000000-0000-0000-8000-0000000000fa', '${TENANT_ID}', 'human', 'pavlo',
          'issue.close', 'issue', '${TARGET_UNREGISTERED}', 'closed issue', '{}', 'ok', null),
         ('00000000-0000-0000-8000-0000000000fd', '${TENANT_ID}', 'human', 'pavlo',
          'deployment.rollback', 'issue', '${TARGET_WRONG_ACTION}', 'rolled back deploy', '{}',
          'ok', '${DECISION_ID}')`,
    );

    prisma = new PrismaClient({ datasourceUrl: pg.url });
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('flags an unregistered action and a registered mutating action with no linked decision, nothing else', async () => {
    const violations = await findUncoveredMutatingActions(prisma);
    expect(violations).toHaveLength(3);

    const uncovered = violations.find((v) => v.includes('00000000-0000-0000-8000-0000000000f7'));
    expect(uncovered).toBeDefined();
    expect(uncovered).toContain('change.open_pull_request');
    expect(uncovered).toContain(TARGET_UNCOVERED);
    expect(uncovered).toContain('no consumed ALLOW decision linked');

    const unregistered = violations.find((v) => v.includes('00000000-0000-0000-8000-0000000000fa'));
    expect(unregistered).toBeDefined();
    expect(unregistered).toContain('issue.close');
    expect(unregistered).toContain(TARGET_UNREGISTERED);
    expect(unregistered).toContain('not a registered policy_action.action_key');
  });

  // Batch 9 follow-up review, round 3: the join's `ON` clause also checks `pd.action_key =
  // ae.action` (and `pd.tenant_id = ae.tenant_id`) — nothing exercised the negative case before
  // this, so deleting either clause would not have failed any test. This audit_entry's
  // `policy_decision_id` points at the real, consumed-ALLOW `change.open_pull_request` decision,
  // but this entry's own `action` is `deployment.rollback` — a different action entirely. Without
  // the `action_key` clause, the join would match on `policy_decision_id` alone and wrongly treat
  // this as covered.
  it("flags an audit_entry whose linked decision is for a different action key, even though the link itself resolves (proves the join's action_key/tenant_id clauses do real work)", async () => {
    const violations = await findUncoveredMutatingActions(prisma);
    const wrongAction = violations.find((v) => v.includes('00000000-0000-0000-8000-0000000000fd'));
    expect(wrongAction).toBeDefined();
    expect(wrongAction).toContain('deployment.rollback');
    expect(wrongAction).toContain(TARGET_WRONG_ACTION);
    expect(wrongAction).toContain('no consumed ALLOW decision linked');
  });

  // Batch 9 I1, review finding: `PublishRuleset` audits as `policy.publish_ruleset`, which was
  // never in `SEED_POLICY_ACTIONS` — batch 8's own LEFT-join fix (unregistered = violation) flagged
  // every ruleset publish, including this spec's own, so the check was red from day one. The rows
  // inserted directly in `beforeAll` above don't exercise the real command; this does.
  it('a real PublishRuleset call — mutating: false, so no consumed ALLOW decision is ever needed — produces zero violations', async () => {
    const tenant = TenantContext.forTrustedInternalUse('00000000-0000-0000-8000-0000000000fb');
    const rulesets = new PrismaPolicyRulesetRepository(prisma);

    await withCorrelation(newCorrelationId(), () =>
      publishRuleset(rulesets, tenant, {
        rules: [
          {
            ruleKey: 'allow-all',
            predicates: [],
            outcome: 'allow',
            reasonCode: 'NO_ADOPTED_EXPECTATION',
            note: '',
          },
        ],
        publishedBy: 'pavlo',
      }),
    );

    const violations = await findUncoveredMutatingActions(prisma);
    expect(violations.filter((v) => v.includes('policy.publish_ruleset'))).toEqual([]);
  });
});
