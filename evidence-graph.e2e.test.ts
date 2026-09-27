import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import {
  PrismaEvidenceGraphRepository,
  PrismaEvidenceLinkRepository,
} from '@healer/domain-evidence';
import { TenantContext, scope, withStep } from '@healer/shared';
import { applySqlFile, query, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * `GetEvidenceGraph` (001 T047, FR-013): the evidence and link rows the timeline reads, arranged
 * as nodes and edges. The arrangement itself is `buildEvidenceGraph`'s unit test; this proves the
 * repository feeds it only the caller's tenant's rows.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-8000-0000000000c1';
const OTHER_TENANT_ID = '00000000-0000-0000-8000-0000000000c2';
const ISSUE_ID = '00000000-0000-0000-8000-0000000000c3';
const EVIDENCE_ID = '00000000-0000-0000-8000-0000000000c4';
const UNCITED_ID = '00000000-0000-0000-8000-0000000000c5';
const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);
const OTHER_CONTEXT = TenantContext.forTrustedInternalUse(OTHER_TENANT_ID);

describe('PrismaEvidenceGraphRepository (001 T047, FR-013)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let graph: PrismaEvidenceGraphRepository;
  const conclusionId = randomUUID();

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
               'fp1', 1, 1, now(), now())`,
    );
    for (const id of [EVIDENCE_ID, UNCITED_ID]) {
      await query(
        pg,
        `insert into "evidence"."evidence"
           (id, tenant_id, issue_id, type, source_system, source_ref, source_label, payload,
            produced_by_step, observed_at, expires_at)
         values ('${id}', '${TENANT_ID}', '${ISSUE_ID}', 'error_signature', 'loki', 'ref1',
                 'from logs', '{}', 'collector', now(), now() + interval '30 days')`,
      );
    }
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    graph = new PrismaEvidenceGraphRepository(prisma);
    await withStep('diagnose', () =>
      new PrismaEvidenceLinkRepository(prisma).write(
        scope(CONTEXT, {
          id: randomUUID(),
          evidenceId: EVIDENCE_ID,
          conclusionType: 'diagnosis',
          conclusionId,
          relation: 'supports',
        }),
      ),
    );
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('returns the issue’s evidence as nodes and its links as edges, uncited evidence included', async () => {
    const result = await graph.forIssue(scope(CONTEXT, { issueId: ISSUE_ID }));

    expect(result.nodes.map((n) => n.id).sort()).toEqual(
      [EVIDENCE_ID, UNCITED_ID, conclusionId].sort(),
    );
    expect(result.edges).toMatchObject([
      { evidenceId: EVIDENCE_ID, conclusionId, relation: 'supports', assertedByStep: 'diagnose' },
    ]);
  });

  it('renders byte-identical output twice (SC-005)', async () => {
    const first = JSON.stringify(await graph.forIssue(scope(CONTEXT, { issueId: ISSUE_ID })));
    const second = JSON.stringify(await graph.forIssue(scope(CONTEXT, { issueId: ISSUE_ID })));

    expect(second).toBe(first);
  });

  it('never returns another tenant’s graph — the query itself is tenant-scoped', async () => {
    expect(await graph.forIssue(scope(OTHER_CONTEXT, { issueId: ISSUE_ID }))).toEqual({
      nodes: [],
      edges: [],
    });
  });
});
