import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@healer/prisma-client';
import { PrismaEvidenceLinkRepository, PrismaEvidenceRepository } from '@healer/domain-evidence';
import { TenantContext, newCorrelationId, scope, withCorrelation, withStep } from '@healer/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applySqlFile,
  query,
  startPostgres,
  type StartedPostgres,
} from '../../../../../test/containers.js';
import { PrismaIssueRepository } from '../../../issues/src/infrastructure/prisma-issue-repository.js';
import { untrustedText } from '../domain/untrusted-text.js';
import type { DocumentResult } from './document-excerpt-payload.js';
import { recordDocumentExcerptEvidence } from './record-document-excerpt-evidence.js';

/**
 * 005 T021 against the real append-only evidence repository and a real Postgres: the excerpt row
 * is written once per (issue, step, version, section, span), carries the snapshot, and is
 * tenant-scoped at the query layer.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../../prisma/migrations/', import.meta.url));
const A = TenantContext.forTrustedInternalUse('00000000-0000-4000-8000-0000000005f1');
const B = TenantContext.forTrustedInternalUse('00000000-0000-4000-8000-0000000005f2');

const inStep = <T>(fn: () => Promise<T>): Promise<T> =>
  withCorrelation(newCorrelationId(), () => withStep('retrieve', fn));

const doc = (): DocumentResult => ({
  kind: 'document',
  tier: 2,
  ruleId: 'intended.adopted',
  ruleSetVersion: 1,
  content: untrustedText('max_payment_retries is 3'),
  documentVersionId: randomUUID(),
  sectionId: randomUUID(),
  matchedSpan: [0, 24],
  provenance: 'human_authored',
  freshness: { lastSyncedAt: '2026-10-01T00:00:00Z' },
  originRef: 'gitlab://acme/docs/checkout.md@abc',
  detached: false,
});

describe('recordDocumentExcerptEvidence e2e (005 T021)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let deps: Parameters<typeof recordDocumentExcerptEvidence>[0];
  let evidence: PrismaEvidenceRepository;
  let issueId: string;

  beforeAll(async () => {
    pg = await startPostgres();
    const names = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    for (const n of names) await applySqlFile(pg, `${MIGRATIONS_DIR}${n}/migration.sql`);
    await query(
      pg,
      `insert into "issue"."normalisation_ruleset" (version, rules) values (1, '{}')`,
    );
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    evidence = new PrismaEvidenceRepository(prisma);
    deps = {
      evidence,
      links: new PrismaEvidenceLinkRepository(prisma),
      now: () => new Date('2026-10-10T10:00:00Z'),
      retentionMs: 86_400_000,
    };
    issueId = await withCorrelation(newCorrelationId(), async () => {
      const created = await new PrismaIssueRepository(prisma).create(
        scope(A, {
          id: randomUUID(),
          kind: 'production_incident',
          environment: 'prod',
          severity: 'high',
          fingerprint: `fp-${randomUUID()}`,
          rulesetVersion: 1,
          firstSeenAt: new Date('2026-01-01T00:00:00Z'),
          lastSeenAt: new Date('2026-01-01T00:00:00Z'),
        }),
      );
      return created.id;
    });
  }, 240_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('writes one document_excerpt row, idempotently, attributed to the step, hidden from another tenant', async () => {
    const r = doc();
    const run = () => inStep(() => recordDocumentExcerptEvidence(deps, A, { issueId, result: r }));
    const first = await run();
    const second = await run();
    expect(second.id).toBe(first.id);
    const rows = await evidence.listByIssue(scope(A, { issueId, type: 'document_excerpt' }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      producedByStep: 'retrieve',
      excerpt: 'max_payment_retries is 3',
      payload: { tier: 2, documentVersionId: r.documentVersionId, detached: false },
    });
    expect(await evidence.findById(scope(B, { id: first.id }))).toBeNull();
    // what reached the database holds the text and facts, never a redaction marker
    const raw = JSON.stringify(rows[0]);
    expect(raw).not.toContain('UntrustedText redacted');
    expect(raw).not.toContain('"untrusted"');
  });

  it('records the link in the same call, attributed by the database to the same step', async () => {
    const r = doc();
    const conclusionId = randomUUID();
    const ev = await inStep(() =>
      recordDocumentExcerptEvidence(deps, A, {
        issueId,
        result: r,
        conclusion: { type: 'diagnosis', id: conclusionId, relation: 'supports' },
      }),
    );
    // a retried job: same call again — one evidence row, one link, and it succeeds
    const again = await inStep(() =>
      recordDocumentExcerptEvidence(deps, A, {
        issueId,
        result: r,
        conclusion: { type: 'diagnosis', id: conclusionId, relation: 'supports' },
      }),
    );
    expect(again.id).toBe(ev.id);
    expect(
      await query(pg, `select count(*) from "evidence"."evidence" where id = '${ev.id}'`),
    ).toBe('1');
    expect(
      await query(
        pg,
        `select count(*) from "evidence"."evidence_link" where evidence_id = '${ev.id}'`,
      ),
    ).toBe('1');
    expect(
      await query(
        pg,
        `select asserted_by_step from "evidence"."evidence_link" where evidence_id = '${ev.id}'`,
      ),
    ).toBe('retrieve');
  });
});
