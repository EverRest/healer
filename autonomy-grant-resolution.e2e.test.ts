import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import {
  checkAutonomyEpoch,
  evaluateAndBind,
  grantAutonomy,
  publishRuleset,
  revokeAutonomy,
  StaleAutonomyEpochError,
  sweepRevokedApprovals,
  PrismaApprovalRequestRepository,
  PrismaAutonomyEpochRepository,
  PrismaAutonomyGrantRepository,
  PrismaPolicyActionRepository,
  PrismaPolicyDecisionRepository,
  PrismaPolicyRulesetRepository,
  type ApprovalCallbackPort,
  type RuleBody,
} from '@healer/domain-policy';
import { TenantContext, newCorrelationId, scope, withCorrelation } from '@healer/shared';
import { buildDecisionInput } from './packages/domain/policy/src/domain/test-support/fixtures.js';
import { applySqlFile, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * 002 Phase 4 (T039-T045): the full loop — a grant is scoped and resolved live at evaluation
 * time (T039, T040), a revocation reaches the very next evaluation with no push mechanism
 * (T041, T042), the tenant epoch it bumps is what an outstanding approval's redemption check
 * refuses against (T043, T044), and the sweep only makes that refusal prompt, never the reason
 * it holds (T045, quickstart 15).
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function allowAtLevel2(): RuleBody {
  return {
    ruleKey: 'allow-l2',
    predicates: [
      { kind: 'enumerated', field: 'action.actionClass', operator: 'equals', value: 'code_change' },
      { kind: 'ordinal', field: 'autonomy.level', operator: 'atLeast', value: 2 },
    ],
    outcome: 'allow',
    reasonCode: 'NO_ADOPTED_EXPECTATION',
    note: '',
  };
}

function requireApprovalAtLevel1(): RuleBody {
  return {
    ruleKey: 'require-approval-l1',
    predicates: [
      { kind: 'enumerated', field: 'action.actionClass', operator: 'equals', value: 'code_change' },
      { kind: 'ordinal', field: 'autonomy.level', operator: 'equals', value: 1 },
    ],
    outcome: 'require_approval',
    reasonCode: 'APPROVAL_REQUIRED',
    note: '',
  };
}

function denyNoGrant(): RuleBody {
  return {
    ruleKey: 'deny-no-grant',
    predicates: [
      { kind: 'enumerated', field: 'action.actionClass', operator: 'equals', value: 'code_change' },
      { kind: 'ordinal', field: 'autonomy.level', operator: 'atMost', value: 0 },
    ],
    outcome: 'deny',
    reasonCode: 'NO_AUTONOMY_GRANT',
    note: '',
  };
}

describe('autonomy grant resolution, revocation and epoch staleness (T039-T045)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let rulesets: PrismaPolicyRulesetRepository;
  let decisions: PrismaPolicyDecisionRepository;
  let autonomyEpochs: PrismaAutonomyEpochRepository;
  let actions: PrismaPolicyActionRepository;
  let autonomyGrants: PrismaAutonomyGrantRepository;
  let approvals: PrismaApprovalRequestRepository;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    await prisma.policyAction.create({
      data: {
        actionKey: 'change.open_pull_request',
        actionClass: 'code_change',
        mutating: true,
        owningSpec: '008',
        introducedAt: new Date('2026-01-01T00:00:00Z'),
      },
    });
    rulesets = new PrismaPolicyRulesetRepository(prisma);
    decisions = new PrismaPolicyDecisionRepository(prisma);
    autonomyEpochs = new PrismaAutonomyEpochRepository(prisma);
    actions = new PrismaPolicyActionRepository(prisma);
    autonomyGrants = new PrismaAutonomyGrantRepository(prisma);
    approvals = new PrismaApprovalRequestRepository(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  function freshTenant() {
    return TenantContext.forTrustedInternalUse(randomUUID());
  }

  async function publishStandardRuleset(context: TenantContext) {
    await withCorrelation(newCorrelationId(), () =>
      publishRuleset(rulesets, context, {
        rules: [allowAtLevel2(), requireApprovalAtLevel1(), denyNoGrant()],
        publishedBy: 'pavlo',
      }),
    );
  }

  // `autonomy_grant.component_id` is `@db.Uuid` (004) — the grant's scope and the proposal's
  // `target.componentId` must be the same real UUID for `resolveAutonomyLevel` to match them.
  const decisionInputFor = (componentId: string) =>
    buildDecisionInput({ target: { ...buildDecisionInput().target, componentId } });

  describe('T039/T040: a grant is resolved live, scoped by component', () => {
    it('a grant scoped to component A authorizes only component A', async () => {
      const context = freshTenant();
      const componentA = randomUUID();
      const componentB = randomUUID();
      await publishStandardRuleset(context);
      await withCorrelation(newCorrelationId(), () =>
        grantAutonomy({ grants: autonomyGrants, actions }, context, {
          actionKey: 'change.open_pull_request',
          level: 2,
          grantedBy: 'pavlo',
          componentId: componentA,
        }),
      );

      const forA = await withCorrelation(newCorrelationId(), () =>
        evaluateAndBind({ rulesets, decisions, autonomyEpochs, actions, autonomyGrants }, context, {
          decisionInput: decisionInputFor(componentA),
        }),
      );
      expect(forA.decision.outcome).toBe('allow');

      // Quickstart 11: grant for component A, propose for component B → refused, reason naming
      // the missing grant.
      const forB = await withCorrelation(newCorrelationId(), () =>
        evaluateAndBind({ rulesets, decisions, autonomyEpochs, actions, autonomyGrants }, context, {
          decisionInput: decisionInputFor(componentB),
        }),
      );
      expect(forB.decision.outcome).toBe('deny');
      expect(forB.decision.reasonCodes).toContain('NO_AUTONOMY_GRANT');
    });
  });

  describe('T041/T042: revocation reaches the very next evaluation, with no push mechanism', () => {
    it('quickstart 12: revoke mid-workflow, the next guarded step denies', async () => {
      const context = freshTenant();
      await publishStandardRuleset(context);
      const grant = await withCorrelation(newCorrelationId(), () =>
        grantAutonomy({ grants: autonomyGrants, actions }, context, {
          actionKey: 'change.open_pull_request',
          level: 2,
          grantedBy: 'pavlo',
        }),
      );

      const before = await withCorrelation(newCorrelationId(), () =>
        evaluateAndBind({ rulesets, decisions, autonomyEpochs, actions, autonomyGrants }, context, {
          decisionInput: decisionInputFor('component-a'),
        }),
      );
      expect(before.decision.outcome).toBe('allow');

      await withCorrelation(newCorrelationId(), () =>
        revokeAutonomy({ grants: autonomyGrants }, context, {
          grantId: grant.id,
          revokedBy: 'pavlo',
        }),
      );

      // Nothing "pushed" this evaluation anything — it is simply a fresh call, re-reading the
      // (now empty) grant table, exactly as T041/T042 require.
      const after = await withCorrelation(newCorrelationId(), () =>
        evaluateAndBind({ rulesets, decisions, autonomyEpochs, actions, autonomyGrants }, context, {
          decisionInput: decisionInputFor('component-a'),
        }),
      );
      expect(after.decision.outcome).toBe('deny');
      expect(after.decision.reasonCodes).toContain('NO_AUTONOMY_GRANT');
    });
  });

  describe('T043: revocation bumps the tenant epoch in the same transaction', () => {
    it('the epoch increments by exactly one per revocation', async () => {
      const context = freshTenant();
      const grant = await withCorrelation(newCorrelationId(), () =>
        grantAutonomy({ grants: autonomyGrants, actions }, context, {
          actionKey: 'change.open_pull_request',
          level: 1,
          grantedBy: 'pavlo',
        }),
      );
      expect(await autonomyEpochs.current(scope(context, {}))).toBe(0n);

      await withCorrelation(newCorrelationId(), () =>
        revokeAutonomy({ grants: autonomyGrants }, context, {
          grantId: grant.id,
          revokedBy: 'pavlo',
        }),
      );
      expect(await autonomyEpochs.current(scope(context, {}))).toBe(1n);
    });
  });

  describe('T044: an approval redeemed against a stale epoch is refused, sweep or no sweep', () => {
    let context: TenantContext;
    let approvalId: string;
    let decisionId: string;
    let recordedEpoch: bigint;

    beforeEach(async () => {
      context = freshTenant();
      await publishStandardRuleset(context);
      const grant = await withCorrelation(newCorrelationId(), () =>
        grantAutonomy({ grants: autonomyGrants, actions }, context, {
          actionKey: 'change.open_pull_request',
          level: 1,
          grantedBy: 'pavlo',
        }),
      );

      // "Approve": a require_approval decision, parked as a pending approval_request recording
      // today's epoch — RequestApproval itself is Phase 7 (out of scope); this is the row shape
      // it will write, built directly since there is no command yet to call.
      const bound = await withCorrelation(newCorrelationId(), () =>
        evaluateAndBind({ rulesets, decisions, autonomyEpochs, actions, autonomyGrants }, context, {
          decisionInput: decisionInputFor('component-a'),
          binding: { workflowRunId: randomUUID() },
        }),
      );
      expect(bound.decision.outcome).toBe('require_approval');
      decisionId = bound.decision.id;
      recordedEpoch = bound.autonomyEpoch;
      approvalId = randomUUID();
      await prisma.approvalRequest.create({
        data: {
          id: approvalId,
          tenantId: context.tenantId,
          decisionId,
          workflowRunId: randomUUID(),
          summary: {},
          evidenceIds: [],
          autonomyEpoch: recordedEpoch,
          expiresAt: new Date('2099-01-01T00:00:00Z'),
          state: 'pending',
        },
      });

      // "Revoke": bumps the epoch past what the approval recorded.
      await withCorrelation(newCorrelationId(), () =>
        revokeAutonomy({ grants: autonomyGrants }, context, {
          grantId: grant.id,
          revokedBy: 'pavlo',
        }),
      );
    });

    it('quickstart 13: redeeming against the current epoch is refused, with the sweep never run', async () => {
      const currentEpoch = await autonomyEpochs.current(scope(context, {}));
      expect(() =>
        checkAutonomyEpoch({ id: approvalId, autonomyEpoch: recordedEpoch }, currentEpoch),
      ).toThrow(StaleAutonomyEpochError);

      // Quickstart 15: "disable the sweep worker" — this test never calls
      // `sweepRevokedApprovals` at all, and the refusal above already held without it.
      const stillPending = await prisma.approvalRequest.findUniqueOrThrow({
        where: { id: approvalId },
      });
      expect(stillPending.state).toBe('pending');
    });

    it('quickstart 14: the sweep resolves the request to revoked and delivers the callback promptly', async () => {
      const delivered: string[] = [];
      const callback: ApprovalCallbackPort = {
        deliver: async (input) => {
          delivered.push(input.approvalId);
        },
      };
      const result = await sweepRevokedApprovals({ approvals, autonomyEpochs }, callback, context);
      expect(result.revoked.map((r) => r.id)).toEqual([approvalId]);
      expect(delivered).toEqual([approvalId]);

      const swept = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approvalId } });
      expect(swept.state).toBe('revoked');

      const decision = await prisma.policyDecision.findUniqueOrThrow({
        where: { id: decisionId },
      });
      expect(decision.invalidatedReason).toBe('epoch_bump');
    });
  });
});
