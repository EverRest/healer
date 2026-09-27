import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySqlFile, query, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * Append-only enforced by the database, not by application discipline (001 T003, T004, R-03).
 * "A repository that merely does not expose an update method is one convenience method away from
 * being wrong" (research.md) — this proves the *database* rejects the mutation, through raw SQL,
 * so no repository code could route around it even by accident.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-0000-000000000e01';
const ISSUE_ID = '00000000-0000-0000-0000-000000000001';
const EVIDENCE_ID = '00000000-0000-0000-0000-000000000002';
const RUN_ID = '00000000-0000-0000-0000-000000000005';

describe('append-only enforcement (001 T003, T004, R-03, quickstart 8)', () => {
  let pg: StartedPostgres;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    await query(
      pg,
      `insert into "issue"."issue"
         (id, tenant_id, kind, environment, severity, state, fingerprint, ruleset_version,
          occurrence_count, first_seen_at, last_seen_at)
       values ('${ISSUE_ID}', '${TENANT_ID}', 'production_incident', 'prod', 'high', 'detected',
               'fp1', 1, 1, now(), now())`,
    );
    await query(
      pg,
      `insert into "evidence"."evidence"
         (id, tenant_id, issue_id, type, source_system, source_ref, source_label, payload,
          produced_by_step, observed_at, expires_at)
       values ('${EVIDENCE_ID}', '${TENANT_ID}', '${ISSUE_ID}', 'error_signature', 'loki', 'ref1',
               'from logs', '{}', 'collector', now(), now() + interval '30 days')`,
    );
  }, 180_000);

  afterAll(async () => {
    await pg?.stop();
  });

  it('rejects an UPDATE that changes anything but evidence.ref_state', async () => {
    await expect(
      query(
        pg,
        `update "evidence"."evidence" set source_label = 'tampered' where id = '${EVIDENCE_ID}'`,
      ),
    ).rejects.toThrow(/append-only/);
  });

  it('accepts evidence.ref_state moving linked -> detached', async () => {
    await query(
      pg,
      `update "evidence"."evidence" set ref_state = 'detached' where id = '${EVIDENCE_ID}'`,
    );
    const state = await query(
      pg,
      `select ref_state from "evidence"."evidence" where id = '${EVIDENCE_ID}'`,
    );
    expect(state).toBe('detached');
  });

  it('rejects moving ref_state backwards, detached -> linked', async () => {
    await expect(
      query(
        pg,
        `update "evidence"."evidence" set ref_state = 'linked' where id = '${EVIDENCE_ID}'`,
      ),
    ).rejects.toThrow(/linked -> detached/);
  });

  it('rejects DELETE on evidence without the privileged bypass', async () => {
    await expect(
      query(pg, `delete from "evidence"."evidence" where id = '${EVIDENCE_ID}'`),
    ).rejects.toThrow(/append-only/);
  });

  it('allows the privileged bypass to delete evidence — the retention path, itself audited elsewhere', async () => {
    await query(
      pg,
      `begin; set local healer.privileged_write = 'on'; delete from "evidence"."evidence" where id = '${EVIDENCE_ID}'; commit;`,
    );
    const remaining = await query(
      pg,
      `select count(*) from "evidence"."evidence" where id = '${EVIDENCE_ID}'`,
    );
    expect(remaining).toBe('0');
  });

  it('rejects UPDATE and DELETE on issue_event unconditionally', async () => {
    const eventId = '00000000-0000-0000-0000-000000000003';
    await query(
      pg,
      `insert into "issue"."issue_event"
         (id, tenant_id, issue_id, type, cause, actor_ref, payload, observed_at)
       values ('${eventId}', '${TENANT_ID}', '${ISSUE_ID}', 'signal_received', 'ingestion', 'system', '{}', now())`,
    );
    await expect(
      query(pg, `update "issue"."issue_event" set actor_ref = 'tampered' where id = '${eventId}'`),
    ).rejects.toThrow(/append-only/);
    await expect(
      query(pg, `delete from "issue"."issue_event" where id = '${eventId}'`),
    ).rejects.toThrow(/append-only/);
  });

  it('rejects UPDATE and DELETE on audit_entry unconditionally', async () => {
    const entryId = '00000000-0000-0000-0000-000000000004';
    await query(
      pg,
      `insert into "audit"."audit_entry"
         (id, tenant_id, actor_type, actor_ref, action, target_type, target_id, reason, evidence_ids, outcome)
       values ('${entryId}', '${TENANT_ID}', 'system', 'system', 'issue.create', 'issue', '${ISSUE_ID}', 'ingested', '{}', 'ok')`,
    );
    await expect(
      query(pg, `update "audit"."audit_entry" set reason = 'tampered' where id = '${entryId}'`),
    ).rejects.toThrow(/append-only/);
    await expect(
      query(pg, `delete from "audit"."audit_entry" where id = '${entryId}'`),
    ).rejects.toThrow(/append-only/);
  });

  it('rejects UPDATE and DELETE on workflow_transition unconditionally (schema.prisma claimed this, no trigger enforced it until review caught the gap)', async () => {
    await query(
      pg,
      `insert into "workflow"."workflow_run"
         (id, tenant_id, issue_id, definition_key, definition_version, state, correlation_id, updated_at)
       values ('${RUN_ID}', '${TENANT_ID}', '${ISSUE_ID}', 'diagnose', 1, 'investigating', '${RUN_ID}', now())`,
    );
    const transitionId = '00000000-0000-0000-0000-000000000006';
    await query(
      pg,
      `insert into "workflow"."workflow_transition"
         (id, tenant_id, run_id, from_state, to_state, cause)
       values ('${transitionId}', '${TENANT_ID}', '${RUN_ID}', 'detected', 'investigating', 'job')`,
    );
    await expect(
      query(
        pg,
        `update "workflow"."workflow_transition" set to_state = 'tampered' where id = '${transitionId}'`,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      query(pg, `delete from "workflow"."workflow_transition" where id = '${transitionId}'`),
    ).rejects.toThrow(/append-only/);
  });

  it('rejects TRUNCATE on an append-only table — row-level triggers alone do not fire on TRUNCATE', async () => {
    await expect(query(pg, `truncate "audit"."audit_entry"`)).rejects.toThrow(/append-only/);
  });

  it('allows the privileged bypass to TRUNCATE', async () => {
    await query(
      pg,
      `begin; set local healer.privileged_write = 'on'; truncate "issue"."issue_event"; commit;`,
    );
    const remaining = await query(pg, `select count(*) from "issue"."issue_event"`);
    expect(remaining).toBe('0');
  });
});
