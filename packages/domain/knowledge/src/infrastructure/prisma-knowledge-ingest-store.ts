import { randomUUID } from 'node:crypto';
import { enqueue, PrismaOutboxTransaction } from '@healer/events';
import { Prisma, withConcurrencyTranslation, type PrismaClient } from '@healer/prisma-client';
import { NotFoundError, type TenantContext } from '@healer/shared';
import type {
  IngestOutcome,
  IngestPlan,
  KnowledgeIngestStore,
} from '../application/ingest-document-version.js';
import { documentVersionIngestedEvent } from '../domain/events.js';
import { unwrapUntrusted } from '../domain/untrusted-text.js';

/** Two ingests collided in a way the database resolved by aborting one; the job may run again. */
export class ConcurrentIngestError extends Error {
  constructor() {
    super('concurrent ingest conflict; retry');
    this.name = 'ConcurrentIngestError';
  }
}

/** The id belongs to an expectation whose versions live in a different document. */
export class StableKeyConflictError extends Error {
  readonly code = 'STABLE_KEY_CONFLICT';
  constructor(readonly stableKey: string) {
    super(`STABLE_KEY_CONFLICT: expectation id ${stableKey} is already owned by another document`);
    this.name = 'StableKeyConflictError';
  }
}

/** The transaction exceeded its time budget (P2028). Not retryable as-is: the work did not finish. */
export class IngestTimeoutError extends Error {
  constructor() {
    super('ingest exceeded its transaction time budget; nothing was written');
    this.name = 'IngestTimeoutError';
  }
}

/** Plain code-unit order: every process locks keys in the same order whatever its locale. */
export function compareStableKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

type Tx = Prisma.TransactionClient;
interface LockedRow {
  id: string;
  current_version_id: string;
}

/**
 * The whole ingest in ONE transaction (T017). Race safety is the schema's unique constraints plus a
 * row lock, not a read-then-write guard: the insert is `ON CONFLICT DO NOTHING` (createMany
 * skipDuplicates), then the row is read `FOR UPDATE`, so the second ingest of one path waits for the
 * first to commit and then sees its version. `version_no` is computed only under that lock.
 */
export class PrismaKnowledgeIngestStore implements KnowledgeIngestStore {
  constructor(private readonly prisma: PrismaClient) {}

  ingest(tenant: TenantContext, plan: IngestPlan): Promise<IngestOutcome> {
    return withConcurrencyTranslation(
      () =>
        this.prisma
          .$transaction((tx) => this.write(tx, tenant, plan), { timeout: 30_000 })
          .catch((e: unknown) => {
            // Before the concurrency translation, which would call P2028 "retry".
            if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2028') {
              throw new IngestTimeoutError();
            }
            throw e;
          }),
      () => new ConcurrentIngestError(),
    );
  }

  private async write(tx: Tx, tenant: TenantContext, plan: IngestPlan): Promise<IngestOutcome> {
    const tenantId = tenant.tenantId;
    const source = await tx.knowledgeSource.findFirst({
      where: { id: plan.sourceId, tenantId, kind: 'repository_markdown' },
      select: { id: true },
    });
    if (source === null) throw new NotFoundError('knowledge source');

    const now = new Date();
    const versionId = randomUUID();
    const candidateDocId = randomUUID();
    await tx.knowledgeDocument.createMany({
      data: [
        {
          id: candidateDocId,
          tenantId,
          sourceId: plan.sourceId,
          externalRef: plan.path,
          title: plan.title,
          documentClass: 'expectation',
          provenance: 'human_authored',
          currentVersionId: versionId, // deferred FK: the version is inserted below, same transaction
          availability: 'available',
        },
      ],
      skipDuplicates: true,
    });
    const [doc] = await tx.$queryRaw<LockedRow[]>`
      SELECT id, current_version_id FROM knowledge.knowledge_document
      WHERE tenant_id = ${tenantId}::uuid AND source_id = ${plan.sourceId}::uuid
        AND external_ref = ${plan.path} FOR UPDATE`;
    if (doc === undefined) throw new NotFoundError('knowledge document');
    const isNew = doc.id === candidateDocId;

    let versionNo = 1;
    let supersedesId: string | null = null;
    if (!isNew) {
      const current = await tx.documentVersion.findFirstOrThrow({
        where: { id: doc.current_version_id, tenantId },
      });
      if (current.contentHash === plan.contentHash) {
        // Unchanged: no version, section or event — only the (mutable) freshness-of-sync marker.
        await tx.knowledgeDocument.update({
          where: { id_tenantId: { id: doc.id, tenantId } },
          data: { lastSyncedAt: now },
        });
        return {
          documentId: doc.id,
          documentVersionId: current.id,
          versionNo: current.versionNo,
          created: false,
        };
      }
      const max = await tx.documentVersion.aggregate({
        where: { tenantId, documentId: doc.id },
        _max: { versionNo: true },
      });
      versionNo = (max._max.versionNo ?? 0) + 1;
      supersedesId = current.id;
    }

    await tx.documentVersion.create({
      data: {
        id: versionId,
        tenantId,
        documentId: doc.id,
        versionNo,
        contentHash: plan.contentHash,
        capturedAt: now,
        // From the repository's record of the last commit — never from the file (T020, R-02).
        sourceModifiedAt: plan.lastCommit.committedAt,
        authorRef: plan.lastCommit.authorRef,
        commitSha: plan.lastCommit.sha,
        supersedesId,
      },
    });
    await tx.knowledgeDocument.update({
      where: { id_tenantId: { id: doc.id, tenantId } },
      data: {
        currentVersionId: versionId,
        title: plan.title,
        sourceModifiedAt: plan.lastCommit.committedAt,
        lastSyncedAt: now,
      },
    });
    await tx.documentSection.createMany({
      data: plan.sections.map((s) => ({
        id: randomUUID(),
        tenantId,
        documentVersionId: versionId,
        ordinal: s.ordinal,
        headingPath: [...s.headingPath],
        // The one reviewed unwrap: persisting text for retrieval is what 'indexing' means.
        content: unwrapUntrusted(s.content, 'indexing'),
        charStart: s.charStart,
        charEnd: s.charEnd,
      })),
    });
    await this.writeExpectations(tx, tenantId, doc.id, versionId, plan, now);
    await tx.knowledgeConstraint.createMany({
      data: plan.constraints.map((c) => ({
        id: randomUUID(),
        tenantId,
        scopeKind: 'feature' as const,
        scopeRef: plan.featureScopeRef,
        name: c.name,
        valueType: c.valueType,
        valueJson: c.valueJson as Prisma.InputJsonValue,
        documentVersionId: versionId,
        provenance: 'human_authored' as const,
      })),
    });
    await enqueue(
      new PrismaOutboxTransaction(tx),
      documentVersionIngestedEvent(tenant, {
        documentId: doc.id,
        versionNo,
        sourceModifiedAt: plan.lastCommit.committedAt.toISOString(),
      }),
    );
    return { documentId: doc.id, documentVersionId: versionId, versionNo, created: true };
  }

  /**
   * Take-over rule: another document may take a `stable_key` iff its owner no longer holds it — the
   * owner is not `available` (deleted at source / unavailable), or the owner's CURRENT version has
   * no expectation version of this key linked to it. Two live files declaring one id stay a conflict.
   * (The owner row is not locked: a concurrent re-declaration by the owner can win that race, and
   * then the next ingest of either file reports the conflict.)
   */
  private async ownerReleased(
    tx: Tx,
    tenantId: string,
    ownerId: string,
    expectedBehaviorId: string,
  ): Promise<boolean> {
    const owner = await tx.knowledgeDocument.findFirst({ where: { id: ownerId, tenantId } });
    if (owner === null || owner.availability !== 'available') return true;
    const declares = await tx.expectedBehaviorVersion.count({
      where: { tenantId, expectedBehaviorId, documentVersionId: owner.currentVersionId },
    });
    return declares === 0;
  }

  /**
   * Same `stable_key` => a new version of the existing expectation, linked to THIS document version
   * even when the text is unchanged: the link is the record that the version still declares the key,
   * which the take-over rule reads. A key dropped from a file is NOT retired — retirement is a human
   * lifecycle action (FR-009); the row and its history simply stop being re-linked.
   */
  private async writeExpectations(
    tx: Tx,
    tenantId: string,
    documentId: string,
    documentVersionId: string,
    plan: IngestPlan,
    now: Date,
  ): Promise<void> {
    // Sorted: two documents sharing ids lock them in one order, so they cannot deadlock.
    const planned = [...plan.expectations].sort((a, b) =>
      compareStableKeys(a.stableKey, b.stableKey),
    );
    for (const e of planned) {
      const candidateId = randomUUID();
      const candidateVersionId = randomUUID();
      await tx.expectedBehavior.createMany({
        data: [
          {
            id: candidateId,
            tenantId,
            stableKey: e.stableKey,
            // A human-authored file is a draft until a human adopts it (anchor_grant, T026): the
            // merge of this file is not by itself an adoption record in this task.
            state: 'draft',
            currentVersionId: candidateVersionId,
            createdAt: now,
          },
        ],
        skipDuplicates: true,
      });
      const [row] = await tx.$queryRaw<LockedRow[]>`
        SELECT id, current_version_id FROM knowledge.expected_behavior
        WHERE tenant_id = ${tenantId}::uuid AND stable_key = ${e.stableKey} FOR UPDATE`;
      if (row === undefined) throw new NotFoundError('expected behavior');
      let versionId = candidateVersionId;
      let versionNo = 1;
      if (row.id !== candidateId) {
        const current = await tx.expectedBehaviorVersion.findFirstOrThrow({
          where: { id: row.current_version_id, tenantId },
          include: { documentVersion: { select: { documentId: true } } },
        });
        const ownerId = current.documentVersion.documentId;
        if (ownerId !== documentId && !(await this.ownerReleased(tx, tenantId, ownerId, row.id))) {
          throw new StableKeyConflictError(e.stableKey);
        }
        const max = await tx.expectedBehaviorVersion.aggregate({
          where: { tenantId, expectedBehaviorId: row.id },
          _max: { versionNo: true },
        });
        versionId = randomUUID();
        versionNo = (max._max.versionNo ?? 0) + 1;
      }
      await tx.expectedBehaviorVersion.create({
        data: {
          id: versionId,
          tenantId,
          expectedBehaviorId: row.id,
          versionNo,
          description: e.description,
          contentHash: e.contentHash,
          documentVersionId,
          provenance: 'human_authored',
          createdAt: now,
        },
      });
      if (row.id !== candidateId) {
        await tx.expectedBehavior.update({
          where: { id_tenantId: { id: row.id, tenantId } },
          data: { currentVersionId: versionId },
        });
      }
    }
  }
}
