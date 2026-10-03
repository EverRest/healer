import { randomUUID } from 'node:crypto';
import { PrismaIssueRepository } from '@healer/domain-issues';
import {
  PrismaApprovalLifecycleRepository,
  PrismaAutonomyEpochRepository,
  PrismaAutonomyGrantRepository,
  PrismaBudgetRepository,
  PrismaPolicyActionRepository,
  PrismaPolicyDecisionRepository,
  PrismaPolicyRulesetRepository,
  evaluateAndBind,
  grantAutonomy,
  publishRuleset,
  requestApproval,
  type ApprovalRequest,
  type RuleBody,
} from '@healer/domain-policy';
import { TenantContext, newCorrelationId, scope, withCorrelation } from '@healer/shared';
import { buildDecisionInput } from '../packages/domain/policy/src/domain/test-support/fixtures.js';

/**
 * A pending approval request for `tenantId`, built through the real commands: a published
 * ruleset whose only rule requires approval, a level-1 grant, a run parked `awaiting_approval`,
 * a `require_approval` decision bound to that run, and `requestApproval` over it. Shared by the
 * HTTP and the isolation e2e tests so none of them hand-builds the row shape (and so a change to
 * what `RequestApproval` writes is a change in one place). `policy_action` must already be seeded.
 */
const REQUIRE_APPROVAL: RuleBody = {
  ruleKey: 'require-approval',
  predicates: [
    { kind: 'enumerated', field: 'action.actionClass', operator: 'equals', value: 'code_change' },
    { kind: 'ordinal', field: 'autonomy.level', operator: 'atLeast', value: 1 },
  ],
  outcome: 'require_approval',
  reasonCode: 'APPROVAL_REQUIRED',
  note: '',
};

// Derived from the repositories' own constructor, so this helper needs no Prisma import of its own
// (`@healer/prisma-client` is confined to infrastructure and tests proper, backend-nestjs.md).
type Prisma = ConstructorParameters<typeof PrismaApprovalLifecycleRepository>[0];

export interface SeededApproval {
  readonly approval: ApprovalRequest;
  readonly grantId: string;
  readonly runId: string;
  readonly decisionId: string;
}

export async function seedPendingApproval(
  prisma: Prisma,
  tenantId: string,
  options: { readonly expiresAt?: Date } = {},
): Promise<SeededApproval> {
  const context = TenantContext.forTrustedInternalUse(tenantId);
  const rulesets = new PrismaPolicyRulesetRepository(prisma);
  const decisions = new PrismaPolicyDecisionRepository(prisma);
  const autonomyEpochs = new PrismaAutonomyEpochRepository(prisma);
  const actions = new PrismaPolicyActionRepository(prisma);
  const autonomyGrants = new PrismaAutonomyGrantRepository(prisma);
  const budgets = new PrismaBudgetRepository(prisma, {
    maxEvaluationSkewMs: Number.POSITIVE_INFINITY,
  });
  const approvals = new PrismaApprovalLifecycleRepository(prisma);
  const inCorrelation = <T>(fn: () => Promise<T>) => withCorrelation(newCorrelationId(), fn);

  await inCorrelation(() =>
    publishRuleset(rulesets, context, { rules: [REQUIRE_APPROVAL], publishedBy: 'pavlo' }),
  );
  const grant = await inCorrelation(() =>
    grantAutonomy({ grants: autonomyGrants, actions }, context, {
      actionKey: 'change.open_pull_request',
      level: 1,
      grantedBy: 'pavlo',
    }),
  );
  // An approval must point at evidence (`RequestApproval` refuses none), and evidence needs an issue.
  await prisma.$executeRaw`insert into "issue"."normalisation_ruleset" (version, rules) values (1, '{}') on conflict do nothing`;
  const issueId = randomUUID();
  await inCorrelation(() =>
    new PrismaIssueRepository(prisma).create(
      scope(context, {
        id: issueId,
        kind: 'production_incident',
        environment: 'prod',
        severity: 'high',
        fingerprint: `fp-${randomUUID()}`,
        rulesetVersion: 1,
        firstSeenAt: new Date('2026-01-01T00:00:00Z'),
        lastSeenAt: new Date('2026-01-01T00:00:00Z'),
      }),
    ),
  );
  const evidenceId = randomUUID();
  await prisma.evidence.create({
    data: {
      id: evidenceId,
      tenantId,
      issueId,
      type: 'error_signature',
      sourceSystem: 'loki',
      sourceRef: 'q1',
      sourceLabel: 'from logs',
      payload: {},
      producedByStep: 'investigate',
      observedAt: new Date('2026-01-01T00:00:00Z'),
      expiresAt: new Date('2027-01-01T00:00:00Z'),
    },
  });
  const runId = randomUUID();
  const expiresAt = options.expiresAt ?? new Date(Date.now() + 24 * 3_600_000);
  await prisma.workflowRun.create({
    data: {
      id: runId,
      tenantId,
      issueId,
      definitionKey: 'remediation',
      definitionVersion: 1,
      state: 'awaiting_approval',
      correlationId: randomUUID(),
      deadlineAt: new Date(expiresAt.getTime() + 3_600_000),
    },
  });
  const { decision, autonomyEpoch } = await inCorrelation(() =>
    evaluateAndBind(
      { rulesets, decisions, autonomyEpochs, actions, autonomyGrants, budgets },
      context,
      {
        decisionInput: buildDecisionInput(),
        binding: { issueId, workflowRunId: runId, workflowState: 'awaiting_approval' },
      },
    ),
  );
  const approval = await inCorrelation(() =>
    requestApproval({ approvals, decisions }, context, {
      decisionId: decision.id,
      evidenceIds: [evidenceId],
      autonomyEpoch,
      expiresAt,
    }),
  );
  return { approval, grantId: grant.id, runId, decisionId: decision.id };
}
