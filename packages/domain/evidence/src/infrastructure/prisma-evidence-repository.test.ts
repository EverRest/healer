import { describe, expect, it } from 'vitest';
import type { Evidence as EvidenceRow } from '@healer/prisma-client';
import { toDomain } from './prisma-evidence-repository.js';

const BASE_ROW: EvidenceRow = {
  id: 'e1',
  tenantId: 't1',
  issueId: 'i1',
  type: 'error_signature',
  sourceSystem: 'loki',
  sourceRef: 'ref1',
  sourceLabel: 'from logs',
  excerpt: null,
  excerptTruncated: false,
  payload: { a: 1 },
  producedByStep: 'collector',
  refState: 'linked',
  observedAt: new Date('2026-01-01T00:00:00Z'),
  receivedAt: new Date('2026-01-01T00:00:01Z'),
  expiresAt: new Date('2026-02-01T00:00:00Z'),
};

describe('toDomain (T006) — reconstructs the excerpt/excerptTruncated union from flat columns', () => {
  it('maps a null excerpt to the null branch regardless of the truncated column', () => {
    const result = toDomain(BASE_ROW);
    expect(result.excerpt).toBeNull();
    expect(result.excerptTruncated).toBe(false);
  });

  it('maps a present excerpt through unchanged, truncated true', () => {
    const result = toDomain({ ...BASE_ROW, excerpt: 'clipped text', excerptTruncated: true });
    expect(result).toMatchObject({ excerpt: 'clipped text', excerptTruncated: true });
  });

  it('maps a present excerpt through unchanged, truncated false', () => {
    const result = toDomain({ ...BASE_ROW, excerpt: 'full text', excerptTruncated: false });
    expect(result).toMatchObject({ excerpt: 'full text', excerptTruncated: false });
  });

  it('carries every other field through unchanged', () => {
    const result = toDomain(BASE_ROW);
    expect(result).toMatchObject({
      id: 'e1',
      tenantId: 't1',
      issueId: 'i1',
      type: 'error_signature',
      sourceSystem: 'loki',
      sourceRef: 'ref1',
      sourceLabel: 'from logs',
      payload: { a: 1 },
      producedByStep: 'collector',
      refState: 'linked',
    });
    expect(result.observedAt).toEqual(BASE_ROW.observedAt);
    expect(result.receivedAt).toEqual(BASE_ROW.receivedAt);
    expect(result.expiresAt).toEqual(BASE_ROW.expiresAt);
  });
});
