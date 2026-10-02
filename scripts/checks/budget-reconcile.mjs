#!/usr/bin/env node
// `check:budget-reconcile` (002 T069, R-10): the derived consumption policy enforces matches the
// `agent_run` and `workflow_run` rows it is derived from.
//
// There is no stored counter to reconcile (T056) — consumption is a SQL aggregate computed on every
// evaluation. So this check recomputes the same definition **independently, in JS, from the raw
// rows** and compares it with the SQL aggregate, per tenant and period key and per issue. The two
// are written separately on purpose: a disagreement is a bug in one of them, found by a check
// rather than by a tenant noticing that the number support shows is not the number policy used.
// The aggregate's one cleverness — a lower bound on `agent_run.started_at` that prunes the scan —
// is exactly the kind of claim ("a run never starts before the window its workflow was pinned to")
// that only an independent recomputation can falsify.
//
// **Measured, never estimated (012 FR-036, T061).** `agent_run.cost` has no provenance column and
// the writer that would record provider-reported cost is not built (012 T059's write path, T094's
// reconciliation against provider usage), so this check cannot *prove* a figure was measured. It
// refuses the forms of estimate it can see — a finished run that recorded tokens but no cost, a
// negative cost, and a run that cost more than the maximum its own step declared (which would make
// the ex-ante charge a guess) — and says so in its failure. When 012's writer lands, add the real
// reconciliation here rather than relaxing these.
import { deriveIssueConsumption, deriveTenantConsumption } from '@healer/domain-policy';
import { PrismaClient } from '../../prisma/generated/client/index.js';
import { isMainModule, runGate, reportAndExit } from '../lib/harness.mjs';

const SPEND_EPSILON = 1e-6; // cost is numeric(12,6)
const TIME_EPSILON_MS = 1;

const dayKey = (d) => d.toISOString().slice(0, 10);
const monthKey = (d) => d.toISOString().slice(0, 7);

function bump(map, key, spend, timeMs) {
  const cur = map.get(key) ?? { spend: 0, timeMs: 0 };
  map.set(key, { spend: cur.spend + spend, timeMs: cur.timeMs + timeMs });
}

/**
 * The budget definition, recomputed from raw rows.
 * @param {{ runs: any[], workflowRuns: any[], decisions: any[] }} rows
 * @param {Date} asOf the instant live runs are measured to
 * @returns {{ tenant: Map<string, {spend: number, timeMs: number}>, issue: Map<string, {spend: number, timeMs: number}> }}
 *   tenant keys are `tenant|day|YYYY-MM-DD` and `tenant|month|YYYY-MM`; issue keys `tenant|issue`
 */
export function recompute(rows, asOf) {
  const tenant = new Map();
  const issue = new Map();
  const addTenant = (tenantId, pinned, spend, timeMs) => {
    bump(tenant, `${tenantId}|day|${dayKey(pinned)}`, spend, timeMs);
    bump(tenant, `${tenantId}|month|${monthKey(pinned)}`, spend, timeMs);
  };

  // A run is pinned to the earlier of its own start and the earliest start among workflow runs
  // sharing its correlation id (T062) — a run that predates its workflow was not requested by it.
  const startByCorrelation = new Map();
  const startById = new Map();
  for (const w of rows.workflowRuns) {
    const k = `${w.tenantId}|${w.correlationId}`;
    const cur = startByCorrelation.get(k);
    if (!cur || w.startedAt < cur) startByCorrelation.set(k, w.startedAt);
    startById.set(`${w.tenantId}|${w.id}`, w.startedAt);
  }

  const landed = new Set(
    rows.runs.filter((r) => r.policyDecisionId && r.finishedAt).map((r) => r.policyDecisionId),
  );

  for (const r of rows.runs) {
    const wfStart = startByCorrelation.get(`${r.tenantId}|${r.correlationId}`);
    const pinned = wfStart && wfStart < r.startedAt ? wfStart : r.startedAt;
    addTenant(r.tenantId, pinned, r.cost, 0);
    if (r.issueId) bump(issue, `${r.tenantId}|${r.issueId}`, r.cost, 0);
  }

  for (const d of rows.decisions) {
    if (d.outcome !== 'allow' || d.invalidatedReason || !(d.reservedSpend > 0)) continue;
    if (landed.has(d.id)) continue; // replaced by the actual cost
    const wfStart = d.workflowRunId && startById.get(`${d.tenantId}|${d.workflowRunId}`);
    const pinned = wfStart && wfStart < d.evaluatedAt ? wfStart : d.evaluatedAt;
    addTenant(d.tenantId, pinned, d.reservedSpend, 0);
    if (d.issueId) bump(issue, `${d.tenantId}|${d.issueId}`, d.reservedSpend, 0);
  }

  for (const w of rows.workflowRuns) {
    const end = w.terminal ? w.updatedAt : asOf;
    const elapsed = Math.max(0, end.getTime() - w.startedAt.getTime());
    addTenant(w.tenantId, w.startedAt, 0, elapsed);
    if (w.issueId) bump(issue, `${w.tenantId}|${w.issueId}`, 0, elapsed);
  }
  return { tenant, issue };
}

/**
 * The measured-not-estimated refusals this check can make (see the header).
 * @param {{ id: string, tenantId: string, cost: number, inputTokens: number, outputTokens: number, finished: boolean, declaredMax: number | null }[]} runs
 * @returns {string[]}
 */
export function findUnmeasuredCostRuns(runs) {
  const out = [];
  for (const r of runs) {
    const where = `agent_run ${r.id} (tenant ${r.tenantId})`;
    if (r.cost < 0) out.push(`${where}: negative cost ${r.cost} is not a measurement`);
    if (r.finished && r.cost === 0 && r.inputTokens + r.outputTokens > 0) {
      out.push(
        `${where}: finished with ${r.inputTokens + r.outputTokens} tokens recorded but no cost — ` +
          'the cost was not measured (012 FR-036)',
      );
    }
    if (r.finished && r.declaredMax !== null && r.cost > r.declaredMax + SPEND_EPSILON) {
      out.push(
        `${where}: cost ${r.cost} exceeds the maximum its step declared (${r.declaredMax}) — ` +
          'the ex-ante charge (R-11) did not bound it',
      );
    }
  }
  return out;
}

async function loadRows(prisma) {
  const runs = await prisma.$queryRaw`
    SELECT id::text AS id, tenant_id::text AS "tenantId", issue_id::text AS "issueId",
           correlation_id::text AS "correlationId", cost::float8 AS cost,
           input_tokens AS "inputTokens", output_tokens AS "outputTokens",
           started_at AS "startedAt", finished_at AS "finishedAt",
           policy_decision_id::text AS "policyDecisionId"
    FROM "agent"."agent_run"`;
  const workflowRuns = await prisma.$queryRaw`
    SELECT id::text AS id, tenant_id::text AS "tenantId", issue_id::text AS "issueId",
           correlation_id::text AS "correlationId", started_at AS "startedAt",
           updated_at AS "updatedAt", (terminal_state IS NOT NULL) AS terminal
    FROM "workflow"."workflow_run"`;
  const decisions = await prisma.$queryRaw`
    SELECT id::text AS id, tenant_id::text AS "tenantId", issue_id::text AS "issueId",
           workflow_run_id::text AS "workflowRunId", evaluated_at AS "evaluatedAt",
           outcome::text AS outcome, invalidated_reason AS "invalidatedReason",
           (budget_state->>'reservedSpend')::float8 AS "reservedSpend"
    FROM "policy"."policy_decision"`;
  return { runs, workflowRuns, decisions };
}

function windowOf(period, key) {
  const start = new Date(period === 'day' ? `${key}T00:00:00Z` : `${key}-01T00:00:00Z`);
  const end = new Date(start);
  if (period === 'day') end.setUTCDate(end.getUTCDate() + 1);
  else end.setUTCMonth(end.getUTCMonth() + 1);
  return { start, end };
}

/**
 * @param {import('../../prisma/generated/client/index.js').PrismaClient} prisma
 * @param {{ asOf?: Date, derive?: { tenant?: Function, issue?: Function } }} [options] `derive`
 *   overrides the SQL aggregate under test — how the e2e test proves a disagreement is reported.
 * @returns {Promise<string[]>} one message per discrepancy or unmeasured-cost run
 */
export async function findBudgetDiscrepancies(prisma, options = {}) {
  const asOf = options.asOf ?? new Date();
  const deriveTenant = options.derive?.tenant ?? deriveTenantConsumption;
  const deriveIssue = options.derive?.issue ?? deriveIssueConsumption;
  const rows = await loadRows(prisma);
  const violations = [];

  const reservedById = new Map(rows.decisions.map((d) => [d.id, d.reservedSpend]));
  violations.push(
    ...findUnmeasuredCostRuns(
      rows.runs.map((r) => ({
        id: r.id,
        tenantId: r.tenantId,
        cost: r.cost,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        finished: Boolean(r.finishedAt),
        declaredMax: r.policyDecisionId ? (reservedById.get(r.policyDecisionId) ?? null) : null,
      })),
    ),
  );

  const expected = recompute(rows, asOf);
  for (const [key, want] of expected.tenant) {
    const [tenantId, period, periodKey] = key.split('|');
    const got = await deriveTenant(prisma, tenantId, windowOf(period, periodKey), asOf);
    if (Math.abs(got.spend - want.spend) > SPEND_EPSILON) {
      violations.push(
        `tenant ${tenantId} ${period} ${periodKey}: derived spend ${got.spend} but agent_run/policy_decision rows give ${want.spend}`,
      );
    }
    if (Math.abs(got.timeMs - want.timeMs) > TIME_EPSILON_MS) {
      violations.push(
        `tenant ${tenantId} ${period} ${periodKey}: derived time ${got.timeMs} ms but workflow_run rows give ${want.timeMs} ms`,
      );
    }
  }
  for (const [key, want] of expected.issue) {
    const [tenantId, issueId] = key.split('|');
    const got = await deriveIssue(prisma, tenantId, issueId, asOf);
    if (Math.abs(got.spend - want.spend) > SPEND_EPSILON) {
      violations.push(
        `issue ${issueId} (tenant ${tenantId}): derived spend ${got.spend} but the rows give ${want.spend}`,
      );
    }
    if (Math.abs(got.timeMs - want.timeMs) > TIME_EPSILON_MS) {
      violations.push(
        `issue ${issueId} (tenant ${tenantId}): derived time ${got.timeMs} ms but the rows give ${want.timeMs} ms`,
      );
    }
  }
  return violations;
}

/* v8 ignore start -- CLI wiring; the check it drives is proven by budget-reconcile.e2e.test.ts */
if (isMainModule(import.meta.url)) {
  const result = await runGate('check:budget-reconcile', async () => {
    const prisma = new PrismaClient();
    try {
      const violations = await findBudgetDiscrepancies(prisma);
      if (violations.length > 0) throw new Error(violations.join('; '));
      process.stderr.write(
        'check:budget-reconcile: derived consumption matches agent_run, policy_decision and workflow_run\n',
      );
    } finally {
      await prisma.$disconnect();
    }
  });
  reportAndExit(result);
}
/* v8 ignore stop */
