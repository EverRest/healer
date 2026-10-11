import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrismaClient, withPrivilegedWrite } from '@healer/prisma-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySqlFile, query, startPostgres, type StartedPostgres } from '../test/containers.js';

/**
 * 005 T006-T010: the `knowledge` schema's database-level guarantees, proven against a real Postgres
 * through raw SQL (no repository could route around them) and, for the append-only pair, through
 * Prisma as well. Not the retrieval tables: `retrieval_query` / `retrieval_result` land in Phase 4
 * (T052), whose migration must wire the same two triggers (see 20261006010000).
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
const T = '00000000-0000-0000-0000-0000000005a1';
const OTHER = '00000000-0000-0000-0000-0000000005a2';
const id = (n: number) => `00000000-0000-0000-0000-0000000005${n.toString(16).padStart(2, '0')}`;
const SRC = id(1);
const DOC = id(2);
const DV = id(3);
const EB = id(4);
const EBV = id(5);
const ADOPT = id(6);
const GRANT = id(7);
const SECTION = id(8);

describe('knowledge schema guarantees (005 T006-T010)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    await query(
      pg,
      `insert into knowledge.knowledge_source (id, tenant_id, kind, adapter_key, connection_state,
         sync_state, document_classes, implemented)
       values ('${SRC}', '${T}', 'repository_markdown', 'gitlab', 'connected', 'idle', '{readme}', true);
       begin;
       insert into knowledge.knowledge_document (id, tenant_id, source_id, external_ref, title,
         document_class, provenance, current_version_id, availability)
       values ('${DOC}', '${T}', '${SRC}', 'docs/checkout.md', 'Checkout', 'readme', 'human_authored',
         '${DV}', 'available');
       insert into knowledge.document_version (id, tenant_id, document_id, version_no, content_hash, captured_at)
       values ('${DV}', '${T}', '${DOC}', 1, 'h1', now());
       commit;
       insert into knowledge.document_section (id, tenant_id, document_version_id, ordinal, heading_path,
         content, char_start, char_end)
       values ('${SECTION}', '${T}', '${DV}', 0, '{Checkout,Retries}', 'The max_payment_retries limit is three', 0, 38);
       begin;
       insert into knowledge.expected_behavior (id, tenant_id, stable_key, state, current_version_id, created_at)
       values ('${EB}', '${T}', 'checkout-002', 'draft', '${EBV}', now());
       insert into knowledge.expected_behavior_version (id, tenant_id, expected_behavior_id, version_no,
         description, content_hash, document_version_id, provenance, created_at)
       values ('${EBV}', '${T}', '${EB}', 1, 'retries at most three times', 'h', '${DV}', 'machine_generated', now());
       commit;
       insert into knowledge.adoption_record (id, tenant_id, expected_behavior_version_id, actor_type,
         actor_ref, seeded_from, adopted_at)
       values ('${ADOPT}', '${T}', '${EBV}', 'human', 'jane@example.com', '[]', now());
       insert into knowledge.anchor_grant (id, tenant_id, expected_behavior_version_id, adoption_record_id, granted_at)
       values ('${GRANT}', '${T}', '${EBV}', '${ADOPT}', now());`,
    );
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  describe('T008/T009 append-only: rejected by the database, not the repository', () => {
    it('document_version: Prisma update, updateMany and delete are rejected', async () => {
      await expect(
        prisma.documentVersion.update({ where: { id: DV }, data: { contentHash: 'x' } }),
      ).rejects.toThrow(/append-only/);
      await expect(
        prisma.documentVersion.updateMany({ data: { contentHash: 'x' } }),
      ).rejects.toThrow(/append-only/);
      await expect(prisma.documentVersion.delete({ where: { id: DV } })).rejects.toThrow(
        /append-only/,
      );
    });

    it('expected_behavior_version: Prisma update and delete are rejected', async () => {
      await expect(
        prisma.expectedBehaviorVersion.update({ where: { id: EBV }, data: { description: 'x' } }),
      ).rejects.toThrow(/append-only/);
      await expect(prisma.expectedBehaviorVersion.delete({ where: { id: EBV } })).rejects.toThrow(
        /append-only/,
      );
    });

    it('adoption_record: Prisma update and delete are rejected', async () => {
      await expect(
        prisma.adoptionRecord.update({ where: { id: ADOPT }, data: { actorRef: 'eve' } }),
      ).rejects.toThrow(/append-only/);
      await expect(prisma.adoptionRecord.delete({ where: { id: ADOPT } })).rejects.toThrow(
        /append-only/,
      );
    });

    it.each([
      ['document_version', `update knowledge.document_version set content_hash = 'x'`],
      [
        'expected_behavior_version',
        `update knowledge.expected_behavior_version set description = 'x'`,
      ],
      ['adoption_record', `update knowledge.adoption_record set actor_ref = 'eve'`],
    ])('%s: raw SQL UPDATE, DELETE and TRUNCATE are rejected', async (table, update) => {
      await expect(query(pg, update)).rejects.toThrow(
        new RegExp(`${table} rows are append-only and cannot be update`),
      );
      await expect(query(pg, `delete from knowledge.${table}`)).rejects.toThrow(
        new RegExp(`${table} rows are append-only and cannot be delete`),
      );
      await expect(query(pg, `truncate knowledge.${table} cascade`)).rejects.toThrow(
        new RegExp(`${table} rows are append-only and cannot be truncated`),
      );
      expect(await query(pg, `select count(*) from knowledge.${table}`)).toBe('1');
    });

    it('keeps the documented privileged bypass (withPrivilegedWrite), and only that', async () => {
      await withPrivilegedWrite(prisma, (tx) =>
        tx.documentVersion.update({ where: { id: DV }, data: { authorRef: 'priv' } }),
      );
      expect(
        await query(pg, `select author_ref from knowledge.document_version where id = '${DV}'`),
      ).toBe('priv');
      // The bypass is transaction-local: the same pool is back to rejecting.
      await expect(
        prisma.documentVersion.update({ where: { id: DV }, data: { authorRef: 'after' } }),
      ).rejects.toThrow(/append-only/);
    });
  });

  describe('T010 anchor_grant: one revocation record, set once', () => {
    const revoke = (set: string) =>
      query(pg, `update knowledge.anchor_grant set ${set} where id = '${GRANT}'`);

    it('rejects every partial revocation (revoked_at / revoked_by / reason must come together)', async () => {
      await expect(revoke(`revoked_at = now()`)).rejects.toThrow(/anchor_grant_revo/);
      await expect(revoke(`revoked_by = 'jane'`)).rejects.toThrow(/anchor_grant_revo/);
      await expect(revoke(`revoked_at = now(), revocation_reason = 'r'`)).rejects.toThrow(
        /anchor_grant_revoked_by_check/,
      );
      await expect(revoke(`revoked_at = now(), revoked_by = 'jane'`)).rejects.toThrow(
        /anchor_grant_revocation_reason_check/,
      );
      await expect(
        revoke(`revoked_at = now(), revoked_by = ' ', revocation_reason = 'why'`),
      ).rejects.toThrow(/anchor_grant_revocation_not_blank_check/);
    });

    it('rejects changing the grant identity or granted_at, and DELETE and TRUNCATE', async () => {
      await expect(revoke(`granted_at = now() + interval '1 day'`)).rejects.toThrow(
        /immutable except its one-time revocation/,
      );
      await expect(revoke(`adoption_record_id = '${id(9)}'`)).rejects.toThrow(
        /immutable except its one-time revocation/,
      );
      await expect(query(pg, `delete from knowledge.anchor_grant`)).rejects.toThrow(
        /cannot be deleted; revoke instead/,
      );
      await expect(query(pg, `truncate knowledge.anchor_grant cascade`)).rejects.toThrow(
        /anchor_grant rows are append-only and cannot be truncated/,
      );
    });

    it('accepts one complete revocation, then rejects changing or clearing it', async () => {
      await revoke(`revoked_at = now(), revoked_by = 'jane', revocation_reason = 'obsolete'`);
      const once = /set once and cannot be changed or cleared/;
      await expect(revoke(`revocation_reason = 'edited'`)).rejects.toThrow(once);
      await expect(
        revoke(`revoked_at = now(), revoked_by = 'eve', revocation_reason = 'again'`),
      ).rejects.toThrow(once);
      await expect(
        revoke(`revoked_at = null, revoked_by = null, revocation_reason = null`),
      ).rejects.toThrow(once);
      expect(
        await query(pg, `select revoked_by from knowledge.anchor_grant where id = '${GRANT}'`),
      ).toBe('jane');
    });

    it('keeps the revocation record to anchor_grant: no adoption_revocation table, no revocation_id', async () => {
      expect(
        await query(
          pg,
          `select count(*) from information_schema.tables where table_name = 'adoption_revocation'`,
        ),
      ).toBe('0');
      expect(
        await query(
          pg,
          `select count(*) from information_schema.columns
           where table_schema = 'knowledge' and table_name = 'adoption_record' and column_name like '%revocation%'`,
        ),
      ).toBe('0');
    });

    it('a grant cannot cite an adoption record made for a different version', async () => {
      const V2 = id(13);
      await query(
        pg,
        `insert into knowledge.expected_behavior_version (id, tenant_id, expected_behavior_id, version_no,
           description, content_hash, document_version_id, provenance, created_at)
         values ('${V2}', '${T}', '${EB}', 2, 'v2', 'h2', '${DV}', 'machine_generated', now())`,
      );
      await expect(
        query(
          pg,
          `insert into knowledge.anchor_grant (id, tenant_id, expected_behavior_version_id, adoption_record_id, granted_at)
           values ('${id(14)}', '${T}', '${V2}', '${ADOPT}', now())`,
        ),
      ).rejects.toThrow(/anchor_grant_adoption_record_id_expected_behavior_version__fkey/);
    });

    it('allows one grant per adopted version and requires an adoption record', async () => {
      await expect(
        query(
          pg,
          `insert into knowledge.anchor_grant (id, tenant_id, expected_behavior_version_id, adoption_record_id, granted_at)
           values ('${id(10)}', '${T}', '${EBV}', '${ADOPT}', now())`,
        ),
      ).rejects.toThrow(/anchor_grant_expected_behavior_version_id_key/);
      await expect(
        query(
          pg,
          `insert into knowledge.anchor_grant (id, tenant_id, expected_behavior_version_id, granted_at)
           values ('${id(10)}', '${T}', '${EBV}', now())`,
        ),
      ).rejects.toThrow(/adoption_record_id/);
    });
  });

  describe('T006/T010 table checks', () => {
    it('hosted_wiki cannot be marked implemented; it can be declared unimplemented', async () => {
      const insert = (implemented: boolean, n: number) =>
        query(
          pg,
          `insert into knowledge.knowledge_source (id, tenant_id, kind, adapter_key, connection_state,
             sync_state, document_classes, implemented)
           values ('${id(n)}', '${T}', 'hosted_wiki', 'none', 'disconnected', 'idle', '{}', ${implemented})`,
        );
      await expect(insert(true, 11)).rejects.toThrow(
        /knowledge_source_hosted_wiki_unimplemented_check/,
      );
      await insert(false, 12);
    });

    it('adoption_record: non-human actor and blank actor_ref are rejected', async () => {
      const base = (actor: string, ref: string) =>
        query(
          pg,
          `insert into knowledge.adoption_record (id, tenant_id, expected_behavior_version_id, actor_type,
             actor_ref, seeded_from, adopted_at)
           values (gen_random_uuid(), '${T}', '${EBV}', '${actor}', '${ref}', '[]', now())`,
        );
      await expect(base('service', 'healer-bot')).rejects.toThrow(/adoption_actor_type/);
      await expect(base('human', '  ')).rejects.toThrow(
        /adoption_record_actor_ref_not_blank_check/,
      );
    });

    it('knowledge_constraint: an anchored constraint cannot stay machine_generated; duplicates are representable', async () => {
      const insert = (provenance: string, grant: string | null) =>
        query(
          pg,
          `insert into knowledge.knowledge_constraint (id, tenant_id, scope_kind, scope_ref, name,
             value_type, value_json, document_version_id, provenance, anchor_grant_id)
           values (gen_random_uuid(), '${T}', 'expected_behavior', '${EB}', 'max_payment_retries', 'int', '3',
             '${DV}', '${provenance}', ${grant ? `'${grant}'` : 'null'})`,
        );
      await expect(insert('machine_generated', GRANT)).rejects.toThrow(
        /knowledge_constraint_anchored_provenance_check/,
      );
      await insert('machine_generated', null);
      await insert('machine_generated', null); // a conflict must be representable (FR-015)
      await insert('human_authored', GRANT);
    });

    it('a row cannot reference another tenant (composite FK)', async () => {
      await expect(
        query(
          pg,
          `insert into knowledge.document_version (id, tenant_id, document_id, version_no, content_hash, captured_at)
           values (gen_random_uuid(), '${OTHER}', '${DOC}', 2, 'h', now())`,
        ),
      ).rejects.toThrow(/document_version_document_id_tenant_id_fkey/);
    });

    it("search_vector is built with the 'simple' regconfig, through the one wrapper", async () => {
      expect(
        await query(
          pg,
          `select pg_get_functiondef('knowledge.section_search_vector(text[],text)'::regprocedure)`,
        ),
      ).toContain("to_tsvector('simple',");
      expect(
        await query(
          pg,
          `select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d
           where d.adrelid = 'knowledge.document_section'::regclass
             and d.adnum = (select attnum from pg_attribute where attrelid = d.adrelid and attname = 'search_vector')`,
        ),
      ).toContain('section_search_vector');
    });

    it("document_section.search_vector is generated with the 'simple' configuration", async () => {
      // 'simple' keeps the identifier whole and unstemmed; the heading path is searchable.
      expect(
        await query(
          pg,
          `select count(*) from knowledge.document_section
           where tenant_id = '${T}' and search_vector @@ to_tsquery('simple', 'max_payment_retries & retries')`,
        ),
      ).toBe('1');
      await expect(
        query(pg, `update knowledge.document_section set search_vector = null`),
      ).rejects.toThrow(/generated/);
    });
  });
});
