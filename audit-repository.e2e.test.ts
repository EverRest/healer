import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import { PrismaAuditRepository, type NewAuditEntry } from '@healer/domain-issues';
import { TenantContext, scope } from '@healer/shared';
import { applySqlFile, query, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * `PrismaAuditRepository` (001 T042/T043, FR-012, SC-007, R-03) — the first real consumer of
 * `audit_entry` and `agent_run` together. `audit_entry`'s own append-only guarantee is already
 * proven by `append-only.e2e.test.ts` (001 T004); this file proves record/read and the SC-007
 * agent-run resolution `AuditRepository` exists to provide.
 *
 * No real caller wires `record` into a live action yet: `action` must be a registered
 * `policy_action.action_key` (002), which does not exist in this repo — flagged in QUESTIONS.md,
 * not built ahead of 002. This proves the mechanism directly, the same way `check:evidence-
 * coverage` (001 T033) proved its own mechanism against a fabricated stand-in.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-8000-0000000000d1';
const OTHER_TENANT_ID = '00000000-0000-0000-8000-0000000000d2';
const ISSUE_ID = '00000000-0000-0000-8000-0000000000d3';
const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);
const OTHER_CONTEXT = TenantContext.forTrustedInternalUse(OTHER_TENANT_ID);

function newEntry(overrides: Partial<NewAuditEntry> = {}): NewAuditEntry {
  return {
    id: randomUUID(),
    actorType: 'human',
    actorRef: 'pavlo',
    action: 'issue.close',
    targetType: 'issue',
    targetId: ISSUE_ID,
    reason: 'closing as resolved',
    evidenceIds: [],
    outcome: 'ok',
    ...overrides,
  };
}

describe('PrismaAuditRepository (001 T042/T043, FR-012, SC-007)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let repo: PrismaAuditRepository;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    await query(
      pg,
      `insert into "issue"."normalisation_ruleset" (version, rules) values (1, '{}')`,
    );
    await query(
      pg,
      `insert into "issue"."issue"
         (id, tenant_id, kind, environment, severity, state, fingerprint, ruleset_version,
          occurrence_count, first_seen_at, last_seen_at)
       values ('${ISSUE_ID}', '${TENANT_ID}', 'production_incident', 'prod', 'high', 'detected',
               'fp-audit-e2e', 1, 1, now(), now())`,
    );
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    repo = new PrismaAuditRepository(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('records an entry and reads it back for the owning tenant', async () => {
    const input = newEntry();
    const recorded = await repo.record(scope(CONTEXT, input));
    expect(recorded).toMatchObject({
      id: input.id,
      tenantId: TENANT_ID,
      actorType: 'human',
      action: 'issue.close',
      targetType: 'issue',
      targetId: ISSUE_ID,
    });

    const entries = await repo.listByTarget(
      scope(CONTEXT, { targetType: 'issue', targetId: ISSUE_ID }),
    );
    expect(entries.map((e) => e.id)).toContain(input.id);
  });

  it('never returns another tenant’s audit entries', async () => {
    const input = newEntry();
    await repo.record(scope(CONTEXT, input));

    const entries = await repo.listByTarget(
      scope(OTHER_CONTEXT, { targetType: 'issue', targetId: ISSUE_ID }),
    );
    expect(entries.some((e) => e.id === input.id)).toBe(false);
  });

  it('listByTarget orders entries oldest first', async () => {
    const targetId = randomUUID();
    const first = await repo.record(scope(CONTEXT, newEntry({ targetId, reason: 'first' })));
    const second = await repo.record(scope(CONTEXT, newEntry({ targetId, reason: 'second' })));

    const entries = await repo.listByTarget(scope(CONTEXT, { targetType: 'issue', targetId }));
    expect(entries.map((e) => e.id)).toEqual([first.id, second.id]);
  });

  it('resolveAgentRunFacts resolves an agent-action entry to its prompt version and model (SC-007)', async () => {
    const promptVersionId = randomUUID();
    await query(
      pg,
      `insert into "prompt"."prompt_version" (id, key, digest, body, published_by)
       values ('${promptVersionId}', 'diagnose-v1', 'digest1', 'body', 'pavlo')`,
    );
    const agentRunId = randomUUID();
    await query(
      pg,
      `insert into "agent"."agent_run"
         (id, tenant_id, correlation_id, agent_kind, prompt_version_id, model_id, provider,
          input_tokens, output_tokens, cost, tool_calls, outcome, started_at)
       values ('${agentRunId}', '${TENANT_ID}', '${randomUUID()}', 'investigator',
               '${promptVersionId}', 'claude-sonnet-5', 'anthropic', 100, 50, 0.05, '[]', 'ok', now())`,
    );
    await repo.record(
      scope(CONTEXT, newEntry({ actorType: 'agent', actorRef: 'investigator', agentRunId })),
    );

    const facts = await repo.resolveAgentRunFacts(scope(CONTEXT, { agentRunId }));
    expect(facts).toEqual({ promptVersionId, modelId: 'claude-sonnet-5' });
  });

  it('resolveAgentRunFacts returns null for an agent_run under another tenant', async () => {
    const promptVersionId = randomUUID();
    await query(
      pg,
      `insert into "prompt"."prompt_version" (id, key, digest, body, published_by)
       values ('${promptVersionId}', 'diagnose-v2', 'digest2', 'body', 'pavlo')`,
    );
    const agentRunId = randomUUID();
    await query(
      pg,
      `insert into "agent"."agent_run"
         (id, tenant_id, correlation_id, agent_kind, prompt_version_id, model_id, provider,
          input_tokens, output_tokens, cost, tool_calls, outcome, started_at)
       values ('${agentRunId}', '${OTHER_TENANT_ID}', '${randomUUID()}', 'investigator',
               '${promptVersionId}', 'claude-sonnet-5', 'anthropic', 100, 50, 0.05, '[]', 'ok', now())`,
    );

    expect(await repo.resolveAgentRunFacts(scope(CONTEXT, { agentRunId }))).toBeNull();
  });

  it('resolveAgentRunFacts returns null for an id naming no agent_run at all', async () => {
    expect(
      await repo.resolveAgentRunFacts(scope(CONTEXT, { agentRunId: randomUUID() })),
    ).toBeNull();
  });
});
