import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsWithholdingLedger } from './withholding-ledger.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('plane-local withholding ledger (003 T003, T020, R-08)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'healer-ledger-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const entry = {
    kind: 'withheld' as const,
    collectorKey: 'loki_logs' as const,
    itemClass: 'error_signature' as const,
    reasonCode: 'redaction_withheld' as const,
    detector: 'private_key_block' as const,
    sourceLocator: 'loki:{app="api"}@2026-01-01T00:00:00Z',
    original: 'raw customer line',
    observedAt: new Date('2026-01-01T00:00:00Z'),
  };

  it('stores the original under a fresh UUID and resolves it locally', () => {
    const ledger = new FsWithholdingLedger(dir, () => new Date('2026-01-02T00:00:00Z'));
    const { localRef } = ledger.record(entry);
    expect(localRef).toMatch(UUID);
    expect(ledger.resolve(localRef)?.original).toBe('raw customer line');
    expect(ledger.record(entry).localRef).not.toBe(localRef);
  });

  it('is on disk only (mode 0600), nothing in memory the control plane could reach', () => {
    const ledger = new FsWithholdingLedger(dir);
    const { localRef } = ledger.record(entry);
    const files = readdirSync(dir);
    expect(files).toEqual([`${localRef}.json`]);
    expect(statSync(join(dir, files[0]!)).mode & 0o777).toBe(0o600);
  });

  it('returns undefined for an unknown or malformed reference — and never walks the filesystem', () => {
    const ledger = new FsWithholdingLedger(dir);
    expect(ledger.resolve('0190b7a0-0000-7000-8000-000000000000')).toBeUndefined();
    expect(ledger.resolve('../../etc/passwd')).toBeUndefined();
  });

  it('caps the stored original and says so', () => {
    const ledger = new FsWithholdingLedger(dir);
    const { localRef } = ledger.record({ ...entry, original: 'x'.repeat(2_000_000) });
    const stored = ledger.resolve(localRef)!;
    expect(stored.original.length).toBeLessThan(2_000_000);
    expect(stored.originalTruncated).toBe(true);
  });

  it('expires on the customer retention, not ours', () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const ledger = new FsWithholdingLedger(dir, () => now, 1000);
    const { localRef } = ledger.record(entry);
    expect(ledger.resolve(localRef)).toBeDefined();
    now = new Date('2026-01-01T00:00:02Z');
    expect(ledger.resolve(localRef)).toBeUndefined();
    expect(ledger.pruneExpired()).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
  });
});
