import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@healer/prisma-client';
import { NotFoundError, TenantContext, withCorrelation } from '@healer/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applySqlFile,
  startPostgres,
  type StartedPostgres,
} from '../../../../../test/containers.js';
import { featureScopeRef, IngestDocumentVersion } from '../application/ingest-document-version.js';
import { FRONT_MATTER_INVALID } from '../domain/front-matter.js';
import { BROKEN_FRONT_MATTER } from '../testing/broken-front-matter.js';
import type {
  RepositoryFileCommit,
  RepositoryMarkdownFile,
  RepositoryMarkdownSource,
} from '../domain/repository-markdown-source.js';
import { unwrapUntrusted } from '../domain/untrusted-text.js';
import {
  PrismaKnowledgeIngestStore,
  StableKeyConflictError,
} from './prisma-knowledge-ingest-store.js';
import {
  PrismaDocumentSectionRepository,
  PrismaDocumentVersionRepository,
  PrismaExpectedBehaviorRepository,
  PrismaKnowledgeConstraintRepository,
  PrismaKnowledgeDocumentRepository,
  PrismaKnowledgeSourceRepository,
} from './prisma-knowledge-repositories.js';

/**
 * 005 T013 + T017-T020 against real Postgres. The repository host is an in-memory fake of the
 * `RepositoryMarkdownSource` port (the GitLab adapter is another task).
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../../prisma/migrations/', import.meta.url));
const A = TenantContext.forTrustedInternalUse('00000000-0000-4000-8000-0000000005a1');
const B = TenantContext.forTrustedInternalUse('00000000-0000-4000-8000-0000000005b2');
const SRC_A = '00000000-0000-4000-8000-00000005a001';
const SRC_B = '00000000-0000-4000-8000-00000005b001';

class FakeSource implements RepositoryMarkdownSource {
  readonly files = new Map<string, RepositoryMarkdownFile>();
  put(path: string, text: string, commit: Partial<RepositoryFileCommit> = {}): void {
    this.files.set(path, {
      path,
      ref: commit.sha ?? 'c0ffee1',
      text,
      lastCommit: {
        sha: commit.sha ?? 'c0ffee1',
        authorRef: commit.authorRef ?? 'alice@example.com',
        committedAt: commit.committedAt ?? new Date('2026-03-01T10:00:00Z'),
      },
    });
  }
  listMarkdown(): Promise<readonly string[]> {
    return Promise.resolve([...this.files.keys()].sort());
  }
  read(path: string): Promise<RepositoryMarkdownFile> {
    const f = this.files.get(path);
    return f === undefined ? Promise.reject(new Error(`no such file ${path}`)) : Promise.resolve(f);
  }
}

const doc = (opts: {
  desc?: string;
  heading?: string;
  retries?: number;
  id?: string;
  body?: string;
  extraFm?: string;
  feature?: string;
  /** Several expectations (`id` / `desc` are the single-expectation shorthand). */
  expectations?: { id: string; desc?: string }[];
  /** Replaces the default constraints block body (indented lines). */
  constraints?: string;
}) => `---
feature: ${opts.feature ?? 'checkout'}
component: checkout-api
${opts.extraFm ?? ''}expected_behaviors:
${(opts.expectations ?? [{ id: opts.id ?? 'checkout-002', desc: opts.desc }])
  .map(
    (e) =>
      `  - id: ${e.id}\n    description: ${e.desc ?? 'a payment is retried at most max_payment_retries times'}`,
  )
  .join('\n')}
constraints:
${
  opts.constraints ??
  `  max_payment_retries: { type: int, value: ${opts.retries ?? 4} }
  reservation_timeout: { type: duration, value: 15s }`
}
---

## ${opts.heading ?? 'Retry policy'}

${opts.body ?? 'Prose for humans.'}
`;

describe('knowledge ingest (005 T013, T017-T020)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let holder: PrismaClient;
  let source: FakeSource;
  let ingest: IngestDocumentVersion;
  const run = <T>(fn: () => Promise<T>): Promise<T> => withCorrelation('corr-005', fn);
  const ingestA = (path: string) => run(() => ingest.execute(A, { sourceId: SRC_A, path }));

  const counts = async () => {
    const [r] = await prisma.$queryRaw<Record<string, bigint>[]>`
      SELECT
        (SELECT count(*) FROM knowledge.knowledge_document WHERE tenant_id = ${A.tenantId}::uuid) AS documents,
        (SELECT count(*) FROM knowledge.document_version WHERE tenant_id = ${A.tenantId}::uuid) AS versions,
        (SELECT count(*) FROM knowledge.document_section WHERE tenant_id = ${A.tenantId}::uuid) AS sections,
        (SELECT count(*) FROM knowledge.expected_behavior WHERE tenant_id = ${A.tenantId}::uuid) AS expectations,
        (SELECT count(*) FROM knowledge.expected_behavior_version WHERE tenant_id = ${A.tenantId}::uuid) AS expectation_versions,
        (SELECT count(*) FROM knowledge.knowledge_constraint WHERE tenant_id = ${A.tenantId}::uuid) AS constraints,
        (SELECT count(*) FROM events.outbox WHERE tenant_id = ${A.tenantId}::uuid) AS outbox`;
    return Object.fromEntries(Object.entries(r!).map(([k, v]) => [k, Number(v)]));
  };

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    holder = new PrismaClient({ datasourceUrl: pg.url });
    for (const [t, id] of [
      [A, SRC_A],
      [B, SRC_B],
    ] as const) {
      await prisma.knowledgeSource.create({
        data: {
          id,
          tenantId: t.tenantId,
          kind: 'repository_markdown',
          adapterKey: 'gitlab',
          connectionState: 'connected',
          syncState: 'idle',
          documentClasses: [],
          implemented: true,
        },
      });
    }
    source = new FakeSource();
    ingest = new IngestDocumentVersion(source, new PrismaKnowledgeIngestStore(prisma));
  }, 600_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await holder?.$disconnect();
    await pg?.stop();
  });

  describe('T018: a broken front matter block leaves the previous version standing', () => {
    // Each case violates exactly one rule (testing/broken-front-matter.ts) and names its cause.
    const BROKEN = BROKEN_FRONT_MATTER;

    it('fails with FRONT_MATTER_INVALID and writes nothing, for every broken shape', async () => {
      source.put('docs/t18.md', doc({}));
      const first = await ingestA('docs/t18.md');
      expect(first).toMatchObject({ versionNo: 1, created: true });
      const before = await counts();
      for (const [name, { text, kind }] of Object.entries(BROKEN)) {
        source.put('docs/t18.md', text, { sha: 'bad' });
        const err = await ingestA('docs/t18.md').then(
          () => null,
          (e: unknown) => e,
        );
        expect(err, name).toMatchObject({ code: FRONT_MATTER_INVALID, kind });
        expect(await counts(), name).toEqual(before);
      }
      const current = await prisma.knowledgeDocument.findFirstOrThrow({
        where: { tenantId: A.tenantId, externalRef: 'docs/t18.md' },
      });
      expect(current.currentVersionId).toBe(first.documentVersionId);
    });

    it('creates no document at all when the first-ever file is broken', async () => {
      source.put('docs/never.md', BROKEN['unterminated']!.text);
      const before = await counts();
      await expect(ingestA('docs/never.md')).rejects.toMatchObject({ code: FRONT_MATTER_INVALID });
      expect(await counts()).toEqual(before);
      expect(
        await prisma.knowledgeDocument.count({
          where: { tenantId: A.tenantId, externalRef: 'docs/never.md' },
        }),
      ).toBe(0);
    });
  });

  describe('T019: a renamed heading and a reworded description are a new version, not a new expectation', () => {
    it('matches by stable_key', async () => {
      source.put(
        'docs/t19.md',
        doc({ id: 't19-001', desc: 'first wording', heading: 'Retry policy' }),
      );
      const v1 = await ingestA('docs/t19.md');
      const c1 = await counts();

      source.put(
        'docs/t19.md',
        doc({ id: 't19-001', desc: 'second wording', heading: 'Retries' }),
        {
          sha: 'c2',
        },
      );
      const v2 = await ingestA('docs/t19.md');
      const c2 = await counts();

      expect(v2.versionNo).toBe(2);
      expect(c2.expectations).toBe(c1.expectations); // same expectation
      expect(c2.expectation_versions).toBe(c1.expectation_versions + 1); // a new version
      const eb = await prisma.expectedBehavior.findFirstOrThrow({
        where: { tenantId: A.tenantId, stableKey: 't19-001' },
        include: { versions: { orderBy: { versionNo: 'asc' } } },
      });
      expect(eb.versions.map((v) => [v.versionNo, v.description, v.provenance])).toEqual([
        [1, 'first wording', 'human_authored'],
        [2, 'second wording', 'human_authored'],
      ]);
      expect(eb.currentVersionId).toBe(eb.versions[1]!.id);
      expect(eb.versions.map((v) => v.documentVersionId)).toEqual([
        v1.documentVersionId,
        v2.documentVersionId,
      ]);
      const sections = await new PrismaDocumentSectionRepository(prisma).listForVersion(
        A,
        v2.documentVersionId,
      );
      expect(sections.map((s) => s.headingPath)).toEqual([['Retries']]);
      const dv2 = await prisma.documentVersion.findFirstOrThrow({
        where: { id: v2.documentVersionId },
      });
      expect(dv2.supersedesId).toBe(v1.documentVersionId);
    });

    it('an unchanged description is still the same expectation, re-linked to the new document version; a changed constraint is a new row', async () => {
      source.put('docs/t19b.md', doc({ id: 't19b-001', retries: 3, feature: 't19b' }));
      await ingestA('docs/t19b.md');
      const c1 = await counts();
      source.put(
        'docs/t19b.md',
        doc({ id: 't19b-001', retries: 5, body: 'new prose', feature: 't19b' }),
        { sha: 'c2' },
      );
      const v2 = await ingestA('docs/t19b.md');
      const c2 = await counts();
      expect(c2.expectations).toBe(c1.expectations);
      expect(c2.expectation_versions).toBe(c1.expectation_versions + 1); // the link that says "still declared"
      expect(c2.constraints).toBe(c1.constraints + 2);
      const rows = await new PrismaKnowledgeConstraintRepository(prisma).listForDocumentVersion(
        A,
        v2.documentVersionId,
      );
      expect(rows.find((r) => r.name === 'max_payment_retries')).toMatchObject({
        valueType: 'int',
        valueJson: 5,
        provenance: 'human_authored',
        scopeKind: 'feature',
      });
      expect(rows.find((r) => r.name === 'reservation_timeout')).toMatchObject({
        valueType: 'duration',
        valueJson: 15000,
      });
    });

    it('is idempotent: the same file again is a no-op for versions/sections/outbox, but bumps last_synced_at', async () => {
      source.put('docs/t19c.md', doc({ id: 't19c-001' }));
      const first = await ingestA('docs/t19c.md');
      const c1 = await counts();
      const before = await prisma.knowledgeDocument.findFirstOrThrow({
        where: { id: first.documentId },
      });
      const again = await ingestA('docs/t19c.md');
      expect(again).toEqual({ ...first, created: false });
      expect(await counts()).toEqual(c1);
      const after = await prisma.knowledgeDocument.findFirstOrThrow({
        where: { id: first.documentId },
      });
      expect(after.lastSyncedAt!.getTime()).toBeGreaterThan(before.lastSyncedAt!.getTime());
      expect(after.currentVersionId).toBe(before.currentVersionId);
    });

    it('a constraint changed or removed in a newer version leaves only what is in force (finder), keeping history', async () => {
      const repo = new PrismaKnowledgeConstraintRepository(prisma);
      const feature = 'finder-currentness';
      const scopeOf = () => featureScopeRef(A, feature);
      source.put('docs/cur.md', doc({ id: 'cur-001', feature, retries: 3 }));
      await ingestA('docs/cur.md');
      expect(
        (await repo.listByScope(A, 'feature', scopeOf(), 'max_payment_retries')).map(
          (c) => c.valueJson,
        ),
      ).toEqual([3]);

      source.put('docs/cur.md', doc({ id: 'cur-001', feature, retries: 5 }), { sha: 'c2' });
      await ingestA('docs/cur.md');
      expect(
        (await repo.listByScope(A, 'feature', scopeOf(), 'max_payment_retries')).map(
          (c) => c.valueJson,
        ),
      ).toEqual([5]);

      // v3 drops max_payment_retries from the front matter: it disappears from the finder.
      source.put(
        'docs/cur.md',
        doc({
          id: 'cur-001',
          feature,
          constraints: '  reservation_timeout: { type: duration, value: 15s }',
        }),
        { sha: 'c3' },
      );
      await ingestA('docs/cur.md');
      expect(await repo.listByScope(A, 'feature', scopeOf(), 'max_payment_retries')).toEqual([]);
      expect((await repo.listByScope(A, 'feature', scopeOf())).map((c) => c.name)).toEqual([
        'reservation_timeout',
      ]);
      // history is append-only: the old rows are still there.
      expect(
        await prisma.knowledgeConstraint.count({
          where: { tenantId: A.tenantId, scopeRef: scopeOf(), name: 'max_payment_retries' },
        }),
      ).toBe(2);
    });

    it('feature names that differ only in case/space land in one scope', async () => {
      source.put('docs/sc1.md', doc({ id: 'sc-001', feature: 'Scope Case', retries: 7 }));
      source.put('docs/sc2.md', doc({ id: 'sc-002', feature: '  scope   case ', retries: 8 }));
      await ingestA('docs/sc1.md');
      await ingestA('docs/sc2.md');
      const rows = await new PrismaKnowledgeConstraintRepository(prisma).listByScope(
        A,
        'feature',
        featureScopeRef(A, 'scope case'),
        'max_payment_retries',
      );
      expect(rows.map((r) => r.valueJson).sort()).toEqual([7, 8]);
    });
  });

  describe('stable_key ownership (R-08, take-over rule)', () => {
    const ebOf = (stableKey: string) =>
      prisma.expectedBehavior.findFirstOrThrow({
        where: { tenantId: A.tenantId, stableKey },
        include: { versions: { orderBy: { versionNo: 'asc' } } },
      });

    it('two live files declaring one id are a conflict, writing nothing', async () => {
      source.put('docs/owner.md', doc({ id: 'owned-001' }));
      await ingestA('docs/owner.md');
      source.put('docs/thief.md', doc({ id: 'owned-001', desc: 'hijacked' }));
      const before = await counts();
      await expect(ingestA('docs/thief.md')).rejects.toBeInstanceOf(StableKeyConflictError);
      expect(await counts()).toEqual(before);
    });

    it('a renamed file takes the id over once the old file is deleted at source', async () => {
      source.put('docs/old-name.md', doc({ id: 'mv-001', desc: 'moving' }));
      const old = await ingestA('docs/old-name.md');
      const before = await ebOf('mv-001');
      source.put('docs/new-name.md', doc({ id: 'mv-001', desc: 'moving' }));
      await expect(ingestA('docs/new-name.md')).rejects.toBeInstanceOf(StableKeyConflictError);

      await prisma.knowledgeDocument.update({
        where: { id_tenantId: { id: old.documentId, tenantId: A.tenantId } },
        data: { availability: 'deleted_at_source' },
      });
      const moved = await ingestA('docs/new-name.md');
      const after = await ebOf('mv-001');
      expect(after.id).toBe(before.id); // same expectation row
      expect(after.versions.map((v) => v.versionNo)).toEqual([1, 2]); // history kept, one new version
      expect(after.versions[1]!.documentVersionId).toBe(moved.documentVersionId);
      expect(after.currentVersionId).toBe(after.versions[1]!.id);
    });

    it('a document takes an id over once the owner dropped it in a newer version', async () => {
      source.put(
        'docs/dropper.md',
        doc({ expectations: [{ id: 'dr-001' }, { id: 'dr-002' }], feature: 'dropper' }),
      );
      await ingestA('docs/dropper.md');
      source.put('docs/taker.md', doc({ id: 'dr-001', feature: 'taker' }));
      await expect(ingestA('docs/taker.md')).rejects.toBeInstanceOf(StableKeyConflictError);

      source.put('docs/dropper.md', doc({ expectations: [{ id: 'dr-002' }], feature: 'dropper' }), {
        sha: 'c2',
      });
      await ingestA('docs/dropper.md');
      const dropped = await ebOf('dr-001');
      // Dropping is not retiring: retirement is a human lifecycle action (FR-009).
      expect(dropped.state).toBe('draft');
      expect(dropped.versions).toHaveLength(1);

      const taken = await ingestA('docs/taker.md');
      const after = await ebOf('dr-001');
      expect(after.id).toBe(dropped.id);
      expect(after.versions.map((v) => v.versionNo)).toEqual([1, 2]);
      expect(after.versions[1]!.documentVersionId).toBe(taken.documentVersionId);
      // the other expectation of the dropper is untouched and still its own
      expect((await ebOf('dr-002')).versions.map((v) => v.versionNo)).toEqual([1, 2]);
      // and the old owner cannot take it back while the new file is live and declares it
      source.put('docs/dropper.md', doc({ expectations: [{ id: 'dr-001' }], feature: 'dropper' }), {
        sha: 'c3',
      });
      await expect(ingestA('docs/dropper.md')).rejects.toBeInstanceOf(StableKeyConflictError);
    });
  });

  describe('T020: freshness and authorship come from the commit, never from the file', () => {
    it('takes sourceModifiedAt/authorRef/commitSha from the last commit and ignores hostile body claims', async () => {
      const hostileBody =
        'author: mallory@evil.test\nmodified: 2001-01-01\nsourceModifiedAt: 1999-12-31\nauthorRef: mallory';
      source.put('docs/t20.md', doc({ id: 't20-001', body: hostileBody }), {
        sha: 'abc123',
        authorRef: 'alice@example.com',
        committedAt: new Date('2026-03-02T09:30:00Z'),
      });
      const v1 = await ingestA('docs/t20.md');
      const row = await prisma.documentVersion.findFirstOrThrow({
        where: { id: v1.documentVersionId },
      });
      expect(row.sourceModifiedAt?.toISOString()).toBe('2026-03-02T09:30:00.000Z');
      expect(row.authorRef).toBe('alice@example.com');
      expect(row.commitSha).toBe('abc123');
      const d = await prisma.knowledgeDocument.findFirstOrThrow({ where: { id: v1.documentId } });
      expect(d.sourceModifiedAt?.toISOString()).toBe('2026-03-02T09:30:00.000Z');
      expect(d.provenance).toBe('human_authored');

      source.put('docs/t20.md', doc({ id: 't20-001', body: `${hostileBody}\nmore` }), {
        sha: 'def456',
        authorRef: 'bob@example.com',
        committedAt: new Date('2026-04-01T00:00:00Z'),
      });
      const v2 = await ingestA('docs/t20.md');
      const row2 = await prisma.documentVersion.findFirstOrThrow({
        where: { id: v2.documentVersionId },
      });
      expect([row2.authorRef, row2.commitSha, row2.sourceModifiedAt?.toISOString()]).toEqual([
        'bob@example.com',
        'def456',
        '2026-04-01T00:00:00.000Z',
      ]);
      const ev = await prisma.outbox.findMany({
        where: { tenantId: A.tenantId, name: 'DocumentVersionIngested', subjectId: v2.documentId },
        orderBy: { occurredAt: 'asc' },
      });
      expect(ev.map((e) => (e.payload as { versionNo: number }).versionNo)).toEqual([1, 2]);
      expect((ev[1]!.payload as { sourceModifiedAt: string }).sourceModifiedAt).toBe(
        '2026-04-01T00:00:00.000Z',
      );
    });

    it('rejects front matter that claims its own author/modified (strict), writing nothing', async () => {
      source.put(
        'docs/t20-hostile.md',
        doc({ id: 't20h-001', extraFm: 'author: mallory\nmodified: 2001-01-01\n' }),
      );
      const before = await counts();
      await expect(ingestA('docs/t20-hostile.md')).rejects.toMatchObject({
        code: FRONT_MATTER_INVALID,
      });
      expect(await counts()).toEqual(before);
    });
  });

  describe('concurrency: two ingests of one path never duplicate a version or an expectation', () => {
    /** Polls pg_stat_activity until `n` backends are blocked on a lock running a statement like `like`. */
    async function waitForBlocked(n: number, like: string): Promise<string[]> {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const rows = await prisma.$queryRaw<{ query: string }[]>`
          SELECT query FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND datname = current_database() AND query ILIKE ${like}`;
        if (rows.length >= n) return rows.map((r) => r.query);
        if (Date.now() > deadline) throw new Error(`fewer than ${n} backends blocked on ${like}`);
        await new Promise((r2) => setImmediate(r2));
      }
    }

    /** Holds a transaction open (running `hold`) until released. */
    async function holdOpen(
      hold: (tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]) => Promise<unknown>,
    ) {
      let release!: () => void;
      let held!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const heldP = new Promise<void>((r) => (held = r));
      const done = holder.$transaction(
        async (tx) => {
          await hold(tx);
          held();
          await gate;
        },
        { timeout: 60_000 },
      );
      await heldP;
      return { release: () => release(), done };
    }

    it('existing document: concurrent changed versions get distinct, consecutive version_no', async () => {
      source.put('docs/race1.md', doc({ id: 'race1-001', desc: 'base' }));
      const base = await ingestA('docs/race1.md');
      const lock = await holdOpen(
        (tx) =>
          tx.$queryRaw`SELECT id FROM knowledge.knowledge_document WHERE id = ${base.documentId}::uuid FOR UPDATE`,
      );
      // Two ingests of the same path with different content: this source alternates its text per read.
      const texts = [
        doc({ id: 'race1-001', desc: 'racer one' }),
        doc({ id: 'race1-001', desc: 'racer two' }),
      ];
      let n = 0;
      const racingSource: RepositoryMarkdownSource = {
        listMarkdown: () => Promise.resolve([]),
        read: () => {
          const text = texts[n++ % 2]!;
          return Promise.resolve({
            path: 'docs/race1.md',
            ref: `r${n}`,
            text,
            lastCommit: {
              sha: `r${n}`,
              authorRef: 'alice@example.com',
              committedAt: new Date('2026-05-01Z'),
            },
          });
        },
      };
      const racer = new IngestDocumentVersion(racingSource, new PrismaKnowledgeIngestStore(prisma));
      const both = Promise.all([
        run(() => racer.execute(A, { sourceId: SRC_A, path: 'docs/race1.md' })),
        run(() => racer.execute(A, { sourceId: SRC_A, path: 'docs/race1.md' })),
      ]);
      await waitForBlocked(2, '%FOR UPDATE%');
      lock.release();
      await lock.done;
      const results = await both;
      expect(results.map((r) => r.versionNo).sort()).toEqual([2, 3]);
      const versions = await prisma.documentVersion.findMany({
        where: { tenantId: A.tenantId, documentId: base.documentId },
        orderBy: { versionNo: 'asc' },
      });
      expect(versions.map((v) => v.versionNo)).toEqual([1, 2, 3]);
      expect(versions[2]!.supersedesId).toBe(versions[1]!.id);
      const eb = await prisma.expectedBehavior.findMany({
        where: { tenantId: A.tenantId, stableKey: 'race1-001' },
        include: { versions: true },
      });
      expect(eb).toHaveLength(1);
      expect(eb[0]!.versions.map((v) => v.versionNo).sort()).toEqual([1, 2, 3]);
    });

    it('first-ever ingest racing itself yields one document, one version, one expectation', async () => {
      source.put('docs/race2.md', doc({ id: 'race2-001' }));
      const lock = await holdOpen(
        (tx) => tx.$executeRaw`LOCK TABLE knowledge.knowledge_document IN SHARE ROW EXCLUSIVE MODE`,
      );
      const both = Promise.all([ingestA('docs/race2.md'), ingestA('docs/race2.md')]);
      // Both backends are provably parked on the same INSERT before either may proceed: the overlap
      // happened, it was not assumed.
      const parked = await waitForBlocked(2, '%INSERT INTO "knowledge"."knowledge_document"%');
      expect(parked).toHaveLength(2);
      lock.release();
      await lock.done;
      const results = await both;
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(results.map((r) => r.documentVersionId)).size).toBe(1);
      expect(
        await prisma.knowledgeDocument.count({
          where: { tenantId: A.tenantId, externalRef: 'docs/race2.md' },
        }),
      ).toBe(1);
      expect(
        await prisma.expectedBehaviorVersion.count({
          where: { tenantId: A.tenantId, expectedBehavior: { stableKey: 'race2-001' } },
        }),
      ).toBe(1);
      expect(
        await prisma.outbox.count({
          where: {
            tenantId: A.tenantId,
            name: 'DocumentVersionIngested',
            subjectId: results[0]!.documentId,
          },
        }),
      ).toBe(1);
    });

    it('two different first-ever documents claiming one new stable_key: exactly one wins, never two expectations', async () => {
      source.put('docs/claim-a.md', doc({ id: 'claim-001', feature: 'claim-a' }));
      source.put('docs/claim-b.md', doc({ id: 'claim-001', feature: 'claim-b' }));
      // Park both ingests at the expected_behavior INSERT (after their documents are written).
      const lock = await holdOpen(
        (tx) => tx.$executeRaw`LOCK TABLE knowledge.expected_behavior IN SHARE ROW EXCLUSIVE MODE`,
      );
      const both = Promise.allSettled([ingestA('docs/claim-a.md'), ingestA('docs/claim-b.md')]);
      const parked = await waitForBlocked(2, '%INSERT INTO "knowledge"."expected_behavior" (%');
      expect(parked).toHaveLength(2);
      lock.release();
      await lock.done;
      const [ra, rb] = await both;
      const outcomes = [ra!, rb!];
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      const lost = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
      expect(lost.reason).toBeInstanceOf(StableKeyConflictError);
      expect(
        await prisma.expectedBehavior.count({
          where: { tenantId: A.tenantId, stableKey: 'claim-001' },
        }),
      ).toBe(1);
      expect(
        await prisma.expectedBehaviorVersion.count({
          where: { tenantId: A.tenantId, expectedBehavior: { stableKey: 'claim-001' } },
        }),
      ).toBe(1);
      // The loser rolled back completely: only one of the two documents exists.
      expect(
        await prisma.knowledgeDocument.count({
          where: {
            tenantId: A.tenantId,
            externalRef: { in: ['docs/claim-a.md', 'docs/claim-b.md'] },
          },
        }),
      ).toBe(1);
    });
  });

  describe('T013: tenant B cannot read tenant A through any finder', () => {
    it("returns not-found / empty per repository, and cannot ingest into A's source", async () => {
      source.put('docs/iso.md', doc({ id: 'iso-001' }));
      const a = await ingestA('docs/iso.md');
      const eb = await prisma.expectedBehavior.findFirstOrThrow({
        where: { tenantId: A.tenantId, stableKey: 'iso-001' },
      });
      const ebv = await prisma.expectedBehaviorVersion.findFirstOrThrow({
        where: { tenantId: A.tenantId, expectedBehaviorId: eb.id },
      });
      const scopeRef = (
        await prisma.knowledgeConstraint.findFirstOrThrow({
          where: { documentVersionId: a.documentVersionId },
        })
      ).scopeRef;

      const sources = new PrismaKnowledgeSourceRepository(prisma);
      const docs = new PrismaKnowledgeDocumentRepository(prisma);
      const versions = new PrismaDocumentVersionRepository(prisma);
      const sections = new PrismaDocumentSectionRepository(prisma);
      const expectations = new PrismaExpectedBehaviorRepository(prisma);
      const constraints = new PrismaKnowledgeConstraintRepository(prisma);

      // Positive controls: A sees its own rows through every finder (a vacuous B check proves nothing).
      expect(await sources.findById(A, SRC_A)).not.toBeNull();
      expect(await docs.findById(A, a.documentId)).not.toBeNull();
      expect(await docs.findByExternalRef(A, SRC_A, 'docs/iso.md')).not.toBeNull();
      expect(await versions.findById(A, a.documentVersionId)).not.toBeNull();
      expect((await versions.listForDocument(A, a.documentId)).length).toBe(1);
      const aSections = await sections.listForVersion(A, a.documentVersionId);
      expect(aSections.length).toBeGreaterThan(0);
      expect(unwrapUntrusted(aSections[0]!.content, 'display')).toContain('Retry policy');
      expect(await expectations.findByStableKey(A, 'iso-001')).not.toBeNull();
      expect(await expectations.findById(A, eb.id)).not.toBeNull();
      expect((await expectations.listVersions(A, eb.id)).length).toBe(1);
      expect(await expectations.findVersionById(A, ebv.id)).not.toBeNull();
      expect(
        (await constraints.listByScope(A, 'feature', scopeRef)).map((c) => c.documentVersionId),
      ).toContain(a.documentVersionId);
      expect((await constraints.listForDocumentVersion(A, a.documentVersionId)).length).toBe(2);

      // Tenant B, A's identifiers.
      expect(await sources.findById(B, SRC_A)).toBeNull();
      expect((await sources.list(B)).map((s) => s.id)).toEqual([SRC_B]);
      expect(await docs.findById(B, a.documentId)).toBeNull();
      expect(await docs.findByExternalRef(B, SRC_A, 'docs/iso.md')).toBeNull();
      expect(await versions.findById(B, a.documentVersionId)).toBeNull();
      expect(await versions.listForDocument(B, a.documentId)).toEqual([]);
      expect(await sections.listForVersion(B, a.documentVersionId)).toEqual([]);
      expect(await expectations.findByStableKey(B, 'iso-001')).toBeNull();
      expect(await expectations.findById(B, eb.id)).toBeNull();
      expect(await expectations.listVersions(B, eb.id)).toEqual([]);
      expect(await expectations.findVersionById(B, ebv.id)).toBeNull();
      expect(await constraints.listByScope(B, 'feature', scopeRef)).toEqual([]);
      expect(await constraints.listForDocumentVersion(B, a.documentVersionId)).toEqual([]);

      const before = await counts();
      await expect(
        run(() => ingest.execute(B, { sourceId: SRC_A, path: 'docs/iso.md' })),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(await counts()).toEqual(before);
    });
  });
});
