import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COLLECTION_CONTRACT_VERSION,
  type CollectionPlanDirective,
  type CollectorKey,
} from '@healer/boundary-contract';
import { TenantContext } from '@healer/shared';
import type { Collector, SourcePort } from './collectors/types.js';
import { Redactor } from './redaction/redactor.js';
import { FsWithholdingLedger } from './withholding-ledger.js';
import type { CollectPassDeps } from './collect-pass.js';

// Test-only builders shared by the 003 US1 tests (marker corpus, withholding, config, repository).

export const TENANT = '0193a1f0-0000-7000-8000-0000000000f1';
export const PASS_ID = '0190b7a0-0000-7000-8000-000000000001';
export const ISSUE_ID = '0190b7a0-0000-7000-8000-000000000002';

export const sourceOf = (records: readonly unknown[]): SourcePort => ({
  read: async () => records,
});

const ITEM_CLASSES_FOR: Record<string, string[]> = {
  loki_logs: ['error_signature', 'stack_frame'],
  otel_traces: ['trace_shape'],
  config_flags: ['config_key_ref'],
  gitlab_commits: ['commit_ref'],
  source_file: ['file_path'],
};

export function planFor(
  keys: readonly CollectorKey[],
  overrides: Partial<CollectionPlanDirective> = {},
): CollectionPlanDirective {
  return {
    kind: 'collection_plan',
    passId: PASS_ID,
    issueRef: ISSUE_ID,
    planDigest: 'sha256:test',
    passOrdinal: 0,
    contractVersion: COLLECTION_CONTRACT_VERSION,
    window: { from: '2026-01-01T00:00:00Z', to: '2026-01-01T01:00:00Z' },
    collectors: keys.map((collectorKey) =>
      collectorKey === 'source_file'
        ? {
            collectorKey,
            parameters: { paths: ['src/a.ts'] },
            timeoutMs: 5000,
            itemClasses: ['file_path'],
          }
        : {
            collectorKey,
            parameters: { component: 'api', environment: 'production' },
            timeoutMs: 5000,
            itemClasses: ITEM_CLASSES_FOR[collectorKey] ?? [],
          },
    ) as CollectionPlanDirective['collectors'],
    budget: { maxWallClockMs: 30_000, maxItemsPerCollector: 500 },
    redactionRulesetVersion: 1,
    ...overrides,
  };
}

export function depsFor(collectors: Partial<Record<CollectorKey, Collector>>): CollectPassDeps & {
  ledger: FsWithholdingLedger;
  ledgerDir: string;
} {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'healer-ledger-'));
  return {
    tenant: TenantContext.forTrustedInternalUse(TENANT),
    collectors,
    redactor: Redactor.forVersion(1, { tenantId: TENANT, pseudonymKey: Buffer.from('test-key') }),
    ledger: new FsWithholdingLedger(ledgerDir),
    ledgerDir,
    runnerImageVersion: '0.55.0',
    now: () => new Date('2026-01-01T01:00:05Z'),
  };
}

// Assembled, not written out: a literal PEM header in a tracked file fails `secret-scan` (the repo idiom, scripts/secret-scan.test.ts).
export const PEM_HEADER = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');
