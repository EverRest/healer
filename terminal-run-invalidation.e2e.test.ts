import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PrismaPolicyDecisionRepository,
  evaluateAndBind,
  onIssueStateChanged,
} from '@healer/domain-policy';
import { withCorrelation } from '@healer/shared';
import { decisionInput, seedIssue, seedWorkflowRun } from './test/budget-fixtures.js';
import {
  NOON,
  startBudgetHarness,
  type BudgetHarness,
} from './test/infrastructure/budget-harness.js';

/** T077 against a real Postgres: `IssueStateChanged` invalidates the unconsumed allows whose run
 *  is terminal, and nothing else. */
describe('IssueStateChanged → run_terminal invalidation', () => {
  let h: BudgetHarness;
  beforeAll(async () => {
    h = await startBudgetHarness();
  }, 180_000);
  afterAll(async () => {
    await h?.stop();
  });

  const bindOn = async (
    t: Awaited<ReturnType<BudgetHarness['newTenant']>>,
    issueId: string,
    workflowRunId: string,
    workflowState = 'step',
  ) =>
    (
      await withCorrelation(randomUUID(), () =>
        evaluateAndBind(h.repos, t.ctx, {
          decisionInput: decisionInput(0.1, NOON),
          binding: { issueId, workflowRunId, workflowState },
        }),
      )
    ).decision.id;

  it('invalidates the allow bound to a terminal run; leaves a live run’s, a consumed one and another tenant’s', async () => {
    const a = await h.newTenant();
    const b = await h.newTenant();
    await h.setLimit(a.ctx, { spendLimit: 100 });
    await h.setLimit(a.ctx, { scopeType: 'issue', period: 'issue', spendLimit: 50 });
    await h.setLimit(b.ctx, { spendLimit: 100 });
    await h.setLimit(b.ctx, { scopeType: 'issue', period: 'issue', spendLimit: 50 });

    const issueId = await seedIssue(h.pg, a.tenantId);
    const done = await seedWorkflowRun(h.pg, {
      tenantId: a.tenantId,
      issueId,
      startedAt: NOON.toISOString(),
      endedAt: NOON.toISOString(),
    });
    const live = await seedWorkflowRun(h.pg, {
      tenantId: a.tenantId,
      issueId,
      startedAt: NOON.toISOString(),
    });
    const onDone = await bindOn(a, issueId, done.id);
    const consumedOnDone = await bindOn(a, issueId, done.id, 'other-step');
    await h.prisma.policyDecision.update({
      where: { id: consumedOnDone },
      data: { consumedAt: new Date() },
    });
    const onLive = await bindOn(a, issueId, live.id);

    const otherIssue = await seedIssue(h.pg, b.tenantId);
    const otherRun = await seedWorkflowRun(h.pg, {
      tenantId: b.tenantId,
      issueId: otherIssue,
      startedAt: NOON.toISOString(),
      endedAt: NOON.toISOString(),
    });
    const theirs = await bindOn(b, otherIssue, otherRun.id);

    const repo = new PrismaPolicyDecisionRepository(h.prisma);
    const event = { name: 'IssueStateChanged', tenantId: a.tenantId, subjectId: issueId };
    expect(await onIssueStateChanged(repo, event)).toBe(1);
    expect(await onIssueStateChanged(repo, event)).toBe(0); // redelivery is a no-op

    const reason = async (id: string) =>
      (await h.prisma.policyDecision.findUnique({ where: { id } }))?.invalidatedReason;
    expect(await reason(onDone)).toBe('run_terminal');
    expect(await reason(consumedOnDone)).toBeNull();
    expect(await reason(onLive)).toBeNull();
    expect(await reason(theirs)).toBeNull();
  });

  // Review of 0.52.0: the case above puts the other tenant's decision on a *different issue*, so
  // dropping either the tenant or the issue filter from the hand-written SQL still passed.
  it('is scoped by tenant AND by issue: neither filter alone is what holds', async () => {
    const a = await h.newTenant();
    const b = await h.newTenant();
    for (const t of [a, b]) {
      await h.setLimit(t.ctx, { spendLimit: 100 });
      await h.setLimit(t.ctx, { scopeType: 'issue', period: 'issue', spendLimit: 50 });
    }
    const terminalRunOn = async (t: typeof a) => {
      const issueId = await seedIssue(h.pg, t.tenantId);
      const run = await seedWorkflowRun(h.pg, {
        tenantId: t.tenantId,
        issueId,
        startedAt: NOON.toISOString(),
        endedAt: NOON.toISOString(),
      });
      return { issueId, decision: await bindOn(t, issueId, run.id) };
    };
    const target = await terminalRunOn(a);
    const sameTenantOtherIssue = await terminalRunOn(a);
    const otherTenant = await terminalRunOn(b);

    const repo = new PrismaPolicyDecisionRepository(h.prisma);
    const reason = async (id: string) =>
      (await h.prisma.policyDecision.findUnique({ where: { id } }))?.invalidatedReason;

    // Tenant A's event naming tenant B's issue matches nothing — the tenant filter, alone.
    const crossTenant = {
      name: 'IssueStateChanged',
      tenantId: a.tenantId,
      subjectId: otherTenant.issueId,
    };
    expect(await onIssueStateChanged(repo, crossTenant)).toBe(0);
    expect(await reason(otherTenant.decision)).toBeNull();

    // Tenant A's event for A's own issue touches only that issue's decision — the issue filter, alone.
    const own = { name: 'IssueStateChanged', tenantId: a.tenantId, subjectId: target.issueId };
    expect(await onIssueStateChanged(repo, own)).toBe(1);
    expect(await reason(target.decision)).toBe('run_terminal');
    expect(await reason(sameTenantOtherIssue.decision)).toBeNull();
    expect(await reason(otherTenant.decision)).toBeNull();
  });
});
