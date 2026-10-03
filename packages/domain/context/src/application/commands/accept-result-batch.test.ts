import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { COLLECTION_CONTRACT_VERSION } from '@healer/boundary-contract';
import type { DomainEvent } from '@healer/events';
import {
  newCorrelationId,
  TenantContext,
  withCorrelation,
  type TenantScoped,
} from '@healer/shared';
import {
  BoundarySchemaRejectedError,
  type BoundaryRejectionRepository,
  type NewBoundaryRejection,
} from '../../domain/boundary-rejection-repository.js';
import { acceptResultBatch } from './accept-result-batch.js';

const CONTEXT = TenantContext.forTrustedInternalUse('00000000-0000-0000-8000-0000000000c1');
const RUNNER = '0190b7a0-0000-7000-8000-0000000000aa';
const MARKER = 'SEEDED-MARKER-jane@example.com';

class InMemoryRejections implements BoundaryRejectionRepository {
  readonly rows: TenantScoped<NewBoundaryRejection>[] = [];
  readonly events: DomainEvent[] = [];
  async record(rejection: TenantScoped<NewBoundaryRejection>, event: DomainEvent): Promise<void> {
    this.rows.push(rejection);
    this.events.push(event);
  }
  list(): never {
    throw new Error('not used');
  }
}

const SIGNATURE = {
  kind: 'error_signature',
  exceptionType: 'TypeError',
  frames: ['src/a.ts'],
  component: 'api',
  environment: 'production',
};

function batch(evidence: Record<string, unknown> = SIGNATURE): Record<string, unknown> {
  return {
    passId: '0190b7a0-0000-7000-8000-000000000001',
    planDigest: 'sha256:abc',
    contractVersion: COLLECTION_CONTRACT_VERSION,
    runnerImageVersion: '0.52.0',
    collectedAt: '2026-01-01T00:00:05Z',
    sourceOutcomes: [
      {
        collectorKey: 'loki_logs',
        status: 'collected',
        itemCount: 1,
        truncated: false,
        durationMs: 1,
      },
    ],
    items: [
      {
        evidence,
        collectorKey: 'loki_logs',
        observedAt: '2026-01-01T00:00:00Z',
        redactionDominated: false,
        redactionRulesetVersion: 1,
      },
    ],
  };
}

function accept(repo: InMemoryRejections, rawBody: string, passId?: string) {
  return withCorrelation(newCorrelationId(), () =>
    acceptResultBatch({ rejections: repo }, CONTEXT, {
      runnerId: RUNNER,
      rawBody,
      ...(passId ? { passId } : {}),
    }),
  );
}

describe('acceptResultBatch (003 T029, R-13)', () => {
  it('returns a conforming batch and records nothing', async () => {
    const repo = new InMemoryRejections();
    const result = await accept(repo, JSON.stringify(batch()));
    expect(result.passId).toBe('0190b7a0-0000-7000-8000-000000000001');
    expect(repo.rows).toEqual([]);
    expect(repo.events).toEqual([]);
  });

  it('rejects a free-form field: one rejection, correct digest and size, and no payload anywhere', async () => {
    const repo = new InMemoryRejections();
    const raw = JSON.stringify(batch({ ...SIGNATURE, message: MARKER }));
    const error = await accept(repo, raw, '0190b7a0-0000-7000-8000-000000000001').catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(BoundarySchemaRejectedError);
    const rejected = error as BoundarySchemaRejectedError;
    expect(rejected.code).toBe('BOUNDARY_SCHEMA_REJECTED');
    expect(rejected.httpStatus).toBe(422);

    expect(repo.rows).toHaveLength(1);
    const row = repo.rows[0]!;
    expect(rejected.rejectionId).toBe(row.id);
    expect(row.tenantId).toBe(CONTEXT.tenantId);
    expect(row.runnerId).toBe(RUNNER);
    expect(row.passId).toBe('0190b7a0-0000-7000-8000-000000000001');
    expect(row.contractVersion).toBe(COLLECTION_CONTRACT_VERSION);
    expect(row.payloadDigest).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(row.byteSize).toBe(Buffer.byteLength(raw));
    expect(row.schemaErrorPaths.length).toBeGreaterThan(0);

    expect(repo.events).toHaveLength(1);
    expect(repo.events[0]!.name).toBe('BoundaryPayloadRejected');
    for (const artefact of [row, repo.events[0], rejected.message, rejected.schemaErrorPaths]) {
      expect(JSON.stringify(artefact)).not.toContain(MARKER);
    }
    expect(rejected.stack ?? '').not.toContain(MARKER);
  });

  it('treats unparseable JSON as a rejection too, and never echoes it', async () => {
    const repo = new InMemoryRejections();
    const raw = `{"items": [${MARKER}`;
    const error = (await accept(repo, raw).catch((e: unknown) => e)) as BoundarySchemaRejectedError;

    expect(error).toBeInstanceOf(BoundarySchemaRejectedError);
    expect(error.schemaErrorPaths).toEqual(['$#invalid_json']);
    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0]!.contractVersion).toBe(COLLECTION_CONTRACT_VERSION);
    expect(repo.rows[0]!.passId).toBeUndefined();
    expect(JSON.stringify([repo.rows, repo.events, error.message])).not.toContain(MARKER);
  });

  it("records the batch's declared contract version when it is a positive integer, else the current one", async () => {
    const repo = new InMemoryRejections();
    await accept(repo, JSON.stringify({ ...batch(), contractVersion: 7, extra: 1 })).catch(
      () => {},
    );
    await accept(repo, JSON.stringify({ contractVersion: 'x' })).catch(() => {});
    await accept(repo, JSON.stringify({ contractVersion: -2 })).catch(() => {});
    expect(repo.rows.map((r) => r.contractVersion)).toEqual([7, 1, 1]);
  });
});

describe('review regressions — a hostile declared version or pass id is still quarantined, never a 500', () => {
  const reject = async (body: unknown, passId?: string) => {
    const repo = new InMemoryRejections();
    await withCorrelation(newCorrelationId(), () =>
      acceptResultBatch({ rejections: repo }, CONTEXT, {
        runnerId: RUNNER,
        rawBody: JSON.stringify(body),
        ...(passId !== undefined ? { passId } : {}),
      }),
    ).catch((e: unknown) => {
      expect(e).toBeInstanceOf(BoundarySchemaRejectedError);
    });
    return repo.rows[0]!;
  };

  it('falls back to the current contract version for a value that does not fit the column', async () => {
    for (const hostile of [3_000_000_000, 1e300, 2 ** 31]) {
      expect((await reject({ contractVersion: hostile })).contractVersion).toBe(
        COLLECTION_CONTRACT_VERSION,
      );
    }
  });

  it('keeps a sane declared version', async () => {
    expect((await reject({ contractVersion: 7 })).contractVersion).toBe(7);
  });

  it('drops a pass id that is not a uuid instead of passing it to a uuid column', async () => {
    const row = await reject({ x: 1 }, "not-a-uuid'; drop table");
    expect(row.passId).toBeUndefined();
  });
});
