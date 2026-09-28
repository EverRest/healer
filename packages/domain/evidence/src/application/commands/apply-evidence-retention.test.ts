import { describe, expect, it } from 'vitest';
import { NotFoundError, TenantContext } from '@healer/shared';
import { applyEvidenceRetention, type RetentionStore } from './apply-evidence-retention.js';
import type { ExpiredEvidence } from '../../domain/retention.js';

const TENANT_ID = '00000000-0000-0000-8000-0000000000ac';
const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);
const NOW = new Date('2026-06-01T00:00:00Z');

function store(
  found: readonly ExpiredEvidence[],
  overrides: Partial<RetentionStore> = {},
): RetentionStore & { readonly purged: string[]; readonly detached: string[] } {
  const purged: string[] = [];
  const detached: string[] = [];
  return {
    purged,
    detached,
    findExpired: async () => found,
    purge: async (where) => {
      purged.push(where.id);
      return true;
    },
    detach: async (where) => {
      detached.push(where.id);
    },
    ...overrides,
  };
}

describe('applyEvidenceRetention (001 T052, R-04, FR-009, FR-018)', () => {
  it('purges expired evidence nothing cites, and only detaches evidence a conclusion cites', async () => {
    const s = store([
      { id: 'unused', referenced: false },
      { id: 'cited', referenced: true },
    ]);

    const result = await applyEvidenceRetention(s, CONTEXT, NOW, 100);

    expect(s.purged).toEqual(['unused']);
    expect(s.detached).toEqual(['cited']);
    expect(result).toEqual({ purged: 1, detached: 1, skipped: 0 });
  });

  it('never purges what a conclusion cites, however expired — a conclusion keeps its support', async () => {
    const s = store([{ id: 'cited', referenced: true }]);

    await applyEvidenceRetention(s, CONTEXT, NOW, 100);

    expect(s.purged).toEqual([]);
  });

  it('asks for evidence expired as of now, capped at the batch size, for this tenant only', async () => {
    const asked: unknown[] = [];
    const s = store([], {
      findExpired: async (where) => {
        asked.push(where);
        return [];
      },
    });

    await applyEvidenceRetention(s, CONTEXT, NOW, 250);

    expect(asked).toEqual([{ tenantId: TENANT_ID, now: NOW, limit: 250 }]);
  });

  it('counts an issue that got cited between the read and the purge as skipped, not purged', async () => {
    const s = store([{ id: 'late-cited', referenced: false }], { purge: async () => false });

    expect(await applyEvidenceRetention(s, CONTEXT, NOW, 100)).toEqual({
      purged: 0,
      detached: 0,
      skipped: 1,
    });
  });

  it('skips evidence that vanished, and keeps going', async () => {
    const s = store(
      [
        { id: 'gone', referenced: true },
        { id: 'kept', referenced: true },
      ],
      {
        detach: async (where) => {
          if (where.id === 'gone') throw new NotFoundError('Evidence');
        },
      },
    );

    const result = await applyEvidenceRetention(s, CONTEXT, NOW, 100);

    expect(result).toEqual({ purged: 0, detached: 1, skipped: 1 });
  });

  it('finishes the batch past an unexpected failure, then fails the job with every error', async () => {
    const boom = new Error('database is down');
    const s = store(
      [
        { id: 'bad', referenced: false },
        { id: 'good', referenced: false },
      ],
      {
        purge: async (where) => {
          if (where.id === 'bad') throw boom;
          return true;
        },
      },
    );

    const failure = await applyEvidenceRetention(s, CONTEXT, NOW, 100).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([boom]);
  });
});
