import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import {
  applyEvidenceRetention,
  PrismaEvidenceLinkRepository,
  PrismaEvidenceRetentionRepository,
} from '@healer/domain-evidence';
import { TenantContext, newCorrelationId, scope, withCorrelation, withStep } from '@healer/shared';
import { applySqlFile, query, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * Evidence retention (001 T052, R-04, R-10, FR-009): expired evidence nothing cites is deleted —
 * the one act the append-only rules forbid except through the privileged bypass — and expired
 * evidence a conclusion cites is only detached. The bypass is the risk: it must not outlive the
 * transaction that needs it, and it must not be able to orphan a link.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-8000-0000000000f3';
const OTHER_TENANT_ID = '00000000-0000-0000-8000-0000000000f4';
const ISSUE_ID = '00000000-0000-0000-8000-0000000000f5';
const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);
const OTHER_CONTEXT = TenantContext.forTrustedInternalUse(OTHER_TENANT_ID);

const NOW = new Date('2026-06-01T00:00:00Z');
const EXPIRED = '2026-05-01T00:00:00Z';
const LIVE = '2026-07-01T00:00:00Z';

describe('PrismaEvidenceRetentionRepository (001 T052, R-04, FR-009)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let retention: PrismaEvidenceRetentionRepository;
  let links: PrismaEvidenceLinkRepository;

  async function evidence(expiresAt: string, excerpt = 'from logs, March'): Promise<string> {
    const id = randomUUID();
    await query(
      pg,
      `insert into "evidence"."evidence"
         (id, tenant_id, issue_id, type, source_system, source_ref, source_label, excerpt, payload,
          produced_by_step, observed_at, expires_at)
       values ('${id}', '${TENANT_ID}', '${ISSUE_ID}', 'error_signature', 'loki', 'ref1',
               'from logs', '${excerpt}', '{}', 'collector', now(), '${expiresAt}')`,
    );
    return id;
  }

  async function cite(evidenceId: string): Promise<void> {
    await withStep('diagnose', () =>
      links.write(
        scope(CONTEXT, {
          id: randomUUID(),
          evidenceId,
          conclusionType: 'diagnosis',
          conclusionId: randomUUID(),
          relation: 'supports',
        }),
      ),
    );
  }

  /** 003: a snapshot over the issue with one `context_item` viewing `evidenceId` (RESTRICT key). */
  async function viewedByContextItem(evidenceId: string): Promise<{ snapshotId: string }> {
    const snapshotId = randomUUID();
    const passId = randomUUID();
    const runId = randomUUID();
    await query(
      pg,
      `insert into "workflow"."workflow_run"
         (id, tenant_id, issue_id, definition_key, definition_version, state, correlation_id, updated_at)
       values ('${runId}', '${TENANT_ID}', '${ISSUE_ID}', 'investigate', 1, 'collecting', '${randomUUID()}', now());
       insert into "context"."context_snapshot"
         (id, tenant_id, issue_id, version, collected_at, window_from, window_to, plan_digest,
          collection_ruleset_version, ranking_ruleset_version, redaction_ruleset_version,
          normalisation_ruleset_version, contract_version, runner_id, runner_image_version,
          completeness, budget_state, finalised_at)
       values ('${snapshotId}', '${TENANT_ID}', '${ISSUE_ID}', (select coalesce(max(version), 0) + 1 from "context"."context_snapshot" where issue_id = '${ISSUE_ID}'),
               now(), now(), now(), 'd', 1, 1, 1, 1, 1, '${randomUUID()}', '0.53.0', '{}', 'within', now());
       insert into "context"."collection_pass"
         (id, tenant_id, snapshot_id, pass_ordinal, plan_digest, requested_plan, resolved_plan,
          requested_by_step, workflow_run_id, callback_id, dispatched_at, outcome)
       values ('${passId}', '${TENANT_ID}', '${snapshotId}', 0, 'd', '{}', '{}', 'system', '${runId}', '${randomUUID()}', now(), 'completed');
       insert into "context"."context_item"
         (id, tenant_id, snapshot_id, pass_id, evidence_id, item_class, collector_key, dedup_key,
          occurrence_count, first_observed_at, last_observed_at, component_attribution,
          relevance_score, ranking_terms, inclusion_state, redaction_dominated)
       values ('${randomUUID()}', '${TENANT_ID}', '${snapshotId}', '${passId}', '${evidenceId}',
               'error_signature', 'loki_logs', 'k-${randomUUID()}', 1, now(), now(), 'resolved', 1, '[]', 'included', false)`,
    );
    return { snapshotId };
  }
  const itemCount = async (evidenceId: string): Promise<string> =>
    query(pg, `select count(*) from "context"."context_item" where evidence_id = '${evidenceId}'`);

  const rowCount = async (id: string): Promise<string> =>
    query(pg, `select count(*) from "evidence"."evidence" where id = '${id}'`);

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
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    retention = new PrismaEvidenceRetentionRepository(prisma);
    links = new PrismaEvidenceLinkRepository(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('has a (tenant_id, expires_at) index, so a run does not scan and sort a tenant’s whole evidence', async () => {
    const indexes = await query(
      pg,
      `select indexdef from pg_indexes
       where schemaname = 'evidence' and tablename = 'evidence'`,
    );

    expect(indexes).toContain('(tenant_id, expires_at)');
  });

  it('finds expired evidence — cited or not — and leaves live evidence alone', async () => {
    const unused = await evidence(EXPIRED);
    const cited = await evidence(EXPIRED);
    await cite(cited);
    const live = await evidence(LIVE);

    const found = await retention.findExpired(scope(CONTEXT, { now: NOW, limit: 1000 }));

    expect(found).toEqual(
      expect.arrayContaining([
        { id: unused, referenced: false },
        { id: cited, referenced: true },
      ]),
    );
    expect(found.map((f) => f.id)).not.toContain(live);
  });

  it('purges expired evidence nothing cites, and writes the audit entry in the same transaction', async () => {
    const id = await evidence(EXPIRED);

    expect(await retention.purge(scope(CONTEXT, { id, now: NOW }))).toBe(true);

    expect(await rowCount(id)).toBe('0');
    const audit = await query(
      pg,
      `select actor_type || '|' || action || '|' || target_type || '|' || outcome
       from "audit"."audit_entry" where target_id = '${id}' and tenant_id = '${TENANT_ID}'`,
    );
    expect(audit).toBe('system|evidence.retention_purge|evidence|purged');
  });

  it('refuses to purge evidence a conclusion cites, and leaves both the row and the link', async () => {
    const id = await evidence(EXPIRED);
    await cite(id);

    expect(await retention.purge(scope(CONTEXT, { id, now: NOW }))).toBe(false);

    expect(await rowCount(id)).toBe('1');
    expect(
      await query(
        pg,
        `select count(*) from "evidence"."evidence_link" where evidence_id = '${id}'`,
      ),
    ).toBe('1');
  });

  it('purges expired evidence a context item merely views — the view goes, the snapshot stays (003)', async () => {
    const id = await evidence(EXPIRED);
    const { snapshotId } = await viewedByContextItem(id);

    expect(await retention.purge(scope(CONTEXT, { id, now: NOW }))).toBe(true);

    expect(await rowCount(id)).toBe('0');
    expect(await itemCount(id)).toBe('0');
    expect(
      await query(
        pg,
        `select count(*) from "context"."context_snapshot" where id = '${snapshotId}'`,
      ),
    ).toBe('1');
  });

  it('still refuses cited evidence, and keeps its context item (003)', async () => {
    const id = await evidence(EXPIRED);
    await viewedByContextItem(id);
    await cite(id);

    expect(await retention.purge(scope(CONTEXT, { id, now: NOW }))).toBe(false);

    expect(await rowCount(id)).toBe('1');
    expect(await itemCount(id)).toBe('1');
  });

  it('refuses to purge evidence that has not expired', async () => {
    const id = await evidence(LIVE);

    expect(await retention.purge(scope(CONTEXT, { id, now: NOW }))).toBe(false);

    expect(await rowCount(id)).toBe('1');
  });

  it('cannot purge another tenant’s evidence — the delete itself is tenant-scoped', async () => {
    const id = await evidence(EXPIRED);

    expect(await retention.purge(scope(OTHER_CONTEXT, { id, now: NOW }))).toBe(false);
    expect(await retention.findExpired(scope(OTHER_CONTEXT, { now: NOW, limit: 1000 }))).toEqual(
      [],
    );

    expect(await rowCount(id)).toBe('1');
  });

  it('does not leave the append-only bypass switched on after a purge', async () => {
    // One connection, so the statement after the purge is guaranteed to run on the very connection
    // the purge used. With a wider pool this could pass by being served a different one.
    const single = new PrismaClient({
      datasourceUrl: `${pg.url}${pg.url.includes('?') ? '&' : '?'}connection_limit=1`,
    });
    try {
      const purging = new PrismaEvidenceRetentionRepository(single);
      expect(await purging.purge(scope(CONTEXT, { id: await evidence(EXPIRED), now: NOW }))).toBe(
        true,
      );
      const survivor = await evidence(EXPIRED);

      // A plain DELETE must still be rejected by the database. If `healer.privileged_write` had
      // survived the transaction, this would delete the row.
      await expect(
        single.$executeRaw`DELETE FROM "evidence"."evidence" WHERE id = ${survivor}::uuid`,
      ).rejects.toThrow();
      expect(await rowCount(survivor)).toBe('1');
    } finally {
      await single.$disconnect();
    }
  });

  it('refuses a purge that races a link still uncommitted — the foreign key answers, and the link survives', async () => {
    const id = await evidence(EXPIRED);
    let commit!: () => void;
    const mayCommit = new Promise<void>((resolve) => (commit = resolve));
    let linked!: () => void;
    const linkInserted = new Promise<void>((resolve) => (linked = resolve));

    // A conclusion citing the record, written but not yet committed: the `NOT EXISTS` in the
    // purge's DELETE cannot see it. The DELETE blocks on the foreign key's lock, the link commits,
    // and only then does the constraint refuse — which the repository must read as "cited".
    const citing = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('healer.current_step', 'diagnose', true)`;
      await tx.evidenceLink.create({
        data: {
          id: randomUUID(),
          tenantId: TENANT_ID,
          evidenceId: id,
          conclusionType: 'diagnosis',
          conclusionId: randomUUID(),
          relation: 'supports',
          assertedByStep: 'diagnose',
        },
      });
      linked();
      await mayCommit;
    });
    await linkInserted;

    const purging = retention.purge(scope(CONTEXT, { id, now: NOW })).then(
      (purged) => purged,
      (error: unknown) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    commit();
    await citing;

    expect(await purging).toBe(false);
    expect(await rowCount(id)).toBe('1');
    expect(
      await query(
        pg,
        `select count(*) from "evidence"."evidence_link" where evidence_id = '${id}'`,
      ),
    ).toBe('1');
  });

  it('through the sweep: unused is purged, cited is detached with its excerpt intact, and a second run finds nothing', () =>
    // `detach` publishes `EvidenceDetached`, which needs the correlation scope the worker runs in.
    withCorrelation(newCorrelationId(), async () => {
      const unused = await evidence(EXPIRED);
      const cited = await evidence(EXPIRED, 'kept for the conclusion');
      await cite(cited);

      const first = await applyEvidenceRetention(retention, CONTEXT, NOW, 1000);

      expect(first.purged).toBeGreaterThanOrEqual(1);
      expect(first.detached).toBeGreaterThanOrEqual(1);
      expect(await rowCount(unused)).toBe('0');
      expect(
        await query(
          pg,
          `select ref_state || '|' || excerpt from "evidence"."evidence" where id = '${cited}'`,
        ),
      ).toBe('detached|kept for the conclusion');
      expect(
        await query(
          pg,
          `select count(*) from "events"."outbox" where name = 'EvidenceDetached' and payload->>'evidenceId' = '${cited}'`,
        ),
      ).toBe('1');

      const second = await applyEvidenceRetention(retention, CONTEXT, NOW, 1000);
      expect(second).toEqual({ purged: 0, detached: 0, skipped: 0 });
    }));
});
