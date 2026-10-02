import { randomUUID } from 'node:crypto';
import type { DecisionInput } from '@healer/domain-policy';
import { query, type StartedPostgres } from './containers.js';

/** A valid `DecisionInput` whose budget group is a *claim* the evaluation overwrites — only
 *  `declaredMaxCost` (the step's own declaration) and `evaluatedAt` survive resolution. */
export function decisionInput(
  declaredMaxCost: number,
  evaluatedAt: Date,
  overrides: Partial<DecisionInput> = {},
): DecisionInput {
  return {
    action: { actionKey: 'change.open_pull_request', actionClass: 'code_change' },
    target: {
      componentId: 'component-1',
      environment: 'production',
      issueKind: 'production_incident',
      targetRef: 'target-1',
      fingerprint: 'fingerprint-1',
    },
    issue: { state: 'diagnosed', classification: 'null_pointer' },
    eligibility: { codeProblemVerdict: 'code_problem', fixEligible: true },
    evidence: { complete: true, conclusionHasLink: true },
    reproduction: { outcome: 'pass' },
    impact: {
      classification: 'localized',
      touchesPublicContract: false,
      touchesMigration: false,
      touchesAuthPath: false,
      touchesMoneyPath: false,
      closure: { memberIds: ['component-1'], maxDepth: 1 },
    },
    reversibility: { reversible: true, hasTestedUndo: true },
    autonomy: { level: 2 },
    budget: { consumed: 0, limit: 1_000_000, declaredMaxCost, degradationStep: 0 },
    cooldown: { recentAllowCount: 0, windowSeconds: 3600, attemptCount: 0 },
    escalation: { attemptCount: 0 },
    evaluatedAt,
    ...overrides,
  };
}

// Seeding and race-observation helpers shared by the budget e2e tests (002 Phase 6). Seeds go
// through raw SQL, not through a repository: `agent_run` and `workflow_run` are 012's tables and
// their writers are not built yet, so the rows a budget aggregates are planted exactly as that
// writer would leave them.

let promptVersionId: string | undefined;

/** One `normalisation_ruleset` + one `prompt_version`, which `issue` and `agent_run` need. */
export async function seedBase(pg: StartedPostgres): Promise<void> {
  await query(pg, `insert into "issue"."normalisation_ruleset" (version, rules) values (1, '{}')`);
  promptVersionId = randomUUID();
  await query(
    pg,
    `insert into "prompt"."prompt_version" (id, key, digest, body, published_by)
     values ('${promptVersionId}', 'diagnose-v1', 'digest1', 'body', 'pavlo')`,
  );
}

export function seededPromptVersionId(): string {
  if (promptVersionId === undefined) throw new Error('call seedBase first');
  return promptVersionId;
}

export async function seedTenant(pg: StartedPostgres, tenantId: string): Promise<void> {
  await query(
    pg,
    `insert into "tenant"."tenant" (id, name, status) values ('${tenantId}', 't-${tenantId}', 'active')`,
  );
}

export async function seedIssue(pg: StartedPostgres, tenantId: string): Promise<string> {
  const id = randomUUID();
  await query(
    pg,
    `insert into "issue"."issue"
       (id, tenant_id, kind, environment, severity, state, fingerprint, ruleset_version,
        occurrence_count, first_seen_at, last_seen_at)
     values ('${id}', '${tenantId}', 'production_incident', 'prod', 'high', 'detected',
             'fp-${id}', 1, 1, now(), now())`,
  );
  return id;
}

export interface SeedAgentRun {
  readonly tenantId: string;
  readonly cost: number;
  readonly issueId?: string;
  readonly correlationId?: string;
  readonly startedAt?: string;
  /** `null` = still running. */
  readonly finishedAt?: string | null;
  readonly policyDecisionId?: string;
  readonly outcome?: string;
}

export async function seedAgentRun(pg: StartedPostgres, run: SeedAgentRun): Promise<string> {
  if (promptVersionId === undefined) throw new Error('call seedBase first');
  const id = randomUUID();
  const started = run.startedAt ?? new Date().toISOString();
  const finished = run.finishedAt === undefined ? started : run.finishedAt;
  await query(
    pg,
    `insert into "agent"."agent_run"
       (id, tenant_id, issue_id, correlation_id, agent_kind, prompt_version_id, model_id, provider,
        input_tokens, output_tokens, cost, tool_calls, policy_decision_id, outcome, started_at, finished_at)
     values ('${id}', '${run.tenantId}', ${run.issueId ? `'${run.issueId}'` : 'null'},
             '${run.correlationId ?? randomUUID()}', 'investigator', '${promptVersionId}',
             'claude-sonnet-5', 'anthropic', 100, 50, ${run.cost}, '[]',
             ${run.policyDecisionId ? `'${run.policyDecisionId}'` : 'null'}, '${run.outcome ?? 'ok'}',
             '${started}', ${finished === null ? 'null' : `'${finished}'`})`,
  );
  return id;
}

export interface SeedWorkflowRun {
  readonly tenantId: string;
  readonly issueId: string;
  readonly startedAt: string;
  readonly correlationId?: string;
  /** Set for a terminal run; `updated_at` is then the last update (the run's end). */
  readonly endedAt?: string;
}

export async function seedWorkflowRun(
  pg: StartedPostgres,
  run: SeedWorkflowRun,
): Promise<{ id: string; correlationId: string }> {
  const id = randomUUID();
  const correlationId = run.correlationId ?? randomUUID();
  await query(
    pg,
    `insert into "workflow"."workflow_run"
       (id, tenant_id, issue_id, definition_key, definition_version, state, correlation_id,
        started_at, updated_at, terminal_state)
     values ('${id}', '${run.tenantId}', '${run.issueId}', 'investigate', 1,
             '${run.endedAt ? 'done' : 'collecting'}', '${correlationId}', '${run.startedAt}',
             '${run.endedAt ?? run.startedAt}', ${run.endedAt ? `'done'` : 'null'})`,
  );
  return { id, correlationId };
}

export async function seedTransition(
  pg: StartedPostgres,
  tenantId: string,
  runId: string,
  toState: string,
): Promise<void> {
  await query(
    pg,
    `insert into "workflow"."workflow_transition" (id, tenant_id, run_id, from_state, to_state, cause)
     values ('${randomUUID()}', '${tenantId}', '${runId}', 'x', '${toState}', 'job')`,
  );
}

// The slice of a Prisma client / transaction client `hold` uses, typed structurally: Prisma's own
// types are confined to infrastructure/** (backend-nestjs.md), and a test helper is not that.
export interface TxLike {
  $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}
export interface PrismaLike {
  $transaction<T>(
    fn: (tx: TxLike) => Promise<T>,
    options?: { timeout?: number; maxWait?: number },
  ): Promise<T>;
}

/**
 * Holds a transaction open (runs `work`, then waits for `release()`) — what makes a race
 * observable without sleeping. `pid` is the holder's backend, so `waitForBlocked` can ask about
 * waiters that began *after* this holder rather than any waiter in the database.
 */
export async function hold(
  prisma: PrismaLike,
  work: (tx: TxLike) => Promise<void>,
  after?: (tx: TxLike) => Promise<void>,
): Promise<{ pid: number; release: () => Promise<void>; rollback: () => Promise<void> }> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  let abort = false;
  let ready!: () => void;
  const isReady = new Promise<void>((resolve) => (ready = resolve));
  let pid = 0;
  const done = prisma.$transaction(
    async (tx) => {
      pid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
      await work(tx);
      ready();
      await gate;
      if (abort) throw new Error('held transaction rolled back on purpose');
      await after?.(tx);
    },
    { timeout: 120_000, maxWait: 60_000 },
  );
  done.catch(() => ready());
  await isReady;
  return {
    pid,
    release: async () => {
      open();
      await done;
    },
    rollback: async () => {
      abort = true;
      open();
      await done.catch(() => undefined);
    },
  };
}

/**
 * Waits until at least `wanted` backends are waiting on a lock **and began that wait after
 * `holder` opened its transaction**, polling `pg_stat_activity`. Fails if they never do — no
 * fixed sleep stands in for "the other transaction has reached the lock".
 */
export async function waitForBlocked(
  pg: StartedPostgres,
  wanted: number,
  holder: { pid: number },
): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const waiting = Number(
      await query(
        pg,
        `select count(*) from pg_stat_activity w
         where w.datname = current_database() and w.wait_event_type = 'Lock'
           and w.pid <> ${holder.pid}
           and w.query_start >= (select h.xact_start from pg_stat_activity h where h.pid = ${holder.pid})`,
      ),
    );
    if (waiting >= wanted) return;
    if (Date.now() > deadline) {
      throw new Error(`expected ${wanted} blocked backend(s), saw ${waiting} — nothing waited`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
