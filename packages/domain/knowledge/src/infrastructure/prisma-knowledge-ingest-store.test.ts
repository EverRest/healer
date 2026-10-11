import { Prisma, type PrismaClient } from '@healer/prisma-client';
import { TenantContext } from '@healer/shared';
import { describe, expect, it } from 'vitest';
import type { IngestPlan } from '../application/ingest-document-version.js';
import {
  compareStableKeys,
  ConcurrentIngestError,
  IngestTimeoutError,
  PrismaKnowledgeIngestStore,
} from './prisma-knowledge-ingest-store.js';

const T = TenantContext.forTrustedInternalUse('00000000-0000-4000-8000-0000000005a1');
const known = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('x', { code, clientVersion: 'test' });
const storeFailingWith = (error: unknown) =>
  new PrismaKnowledgeIngestStore({
    $transaction: () => Promise.reject(error),
  } as unknown as PrismaClient);

describe('PrismaKnowledgeIngestStore error mapping', () => {
  it('reports a transaction timeout (P2028) as a distinct, non-retryable IngestTimeoutError', async () => {
    const err = await storeFailingWith(known('P2028'))
      .ingest(T, {} as IngestPlan)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IngestTimeoutError);
    expect(err).not.toBeInstanceOf(ConcurrentIngestError);
    expect((err as Error).message).not.toMatch(/retry/i);
  });

  it('still maps a serialization failure (P2034) to the retryable ConcurrentIngestError', async () => {
    await expect(
      storeFailingWith(known('P2034')).ingest(T, {} as IngestPlan),
    ).rejects.toBeInstanceOf(ConcurrentIngestError);
  });

  it('passes other errors through untouched', async () => {
    const boom = new Error('boom');
    await expect(storeFailingWith(boom).ingest(T, {} as IngestPlan)).rejects.toBe(boom);
  });
});

describe('lock order', () => {
  it('compares stable keys by code unit, independent of locale', () => {
    const keys = ['a', 'B', '_x', 'Z', 'é', 'a-1', 'A'];
    const sorted = [...keys].sort(compareStableKeys);
    expect(sorted).toEqual(['A', 'B', 'Z', '_x', 'a', 'a-1', 'é']);
    // localeCompare would put 'a' before 'B': the order two processes must agree on is not that.
    expect(['a', 'B'].sort(compareStableKeys)).toEqual(['B', 'a']);
    expect(compareStableKeys('x', 'x')).toBe(0);
  });
});
