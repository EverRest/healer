import { describe, expect, it } from 'vitest';
import { TenantContext } from '@healer/shared';
import { buildCollectionPassAudit, COLLECT_PASS_AUDIT_ACTION } from './collection-audit.js';

const context = TenantContext.forTrustedInternalUse('0193a1f0-0000-7000-8000-0000000000f1');

const input = {
  auditId: '0193a1f0-0000-7000-8000-0000000000a1',
  runnerId: 'runner-1',
  passId: '0193a1f0-0000-7000-8000-0000000000b1',
  planDigest: 'sha256:abc',
  contractVersion: 1,
  rulesetVersions: { collection: 3, redaction: 2, normalisation: 1, ranking: 1 },
  sourceOutcomes: [
    { collectorKey: 'loki_logs' as const, status: 'collected' as const },
    {
      collectorKey: 'prometheus_metrics' as const,
      status: 'unavailable' as const,
      reasonCode: 'source_unreachable' as const,
    },
  ],
  itemsTransmitted: 7,
  itemsWithheld: 2,
  evidenceIds: ['e1', 'e2'],
};

describe('one audit entry per collection pass (003 T015, FR-027)', () => {
  it('records plan digest, ruleset versions, per-source outcomes, counts and contract version', () => {
    const entry = buildCollectionPassAudit(context, input);
    expect(entry.action).toBe(COLLECT_PASS_AUDIT_ACTION);
    expect(entry.targetType).toBe('collection_pass');
    expect(entry.targetId).toBe(input.passId);
    expect(entry.tenantId).toBe(context.tenantId);
    expect(entry.outcome).toBe('degraded');
    expect(JSON.parse(entry.reason)).toEqual({
      planDigest: 'sha256:abc',
      contractVersion: 1,
      rulesetVersions: { collection: 3, redaction: 2, normalisation: 1, ranking: 1 },
      sourceOutcomes: [
        { collectorKey: 'loki_logs', status: 'collected' },
        {
          collectorKey: 'prometheus_metrics',
          status: 'unavailable',
          reasonCode: 'source_unreachable',
        },
      ],
      itemsTransmitted: 7,
      itemsWithheld: 2,
    });
  });

  it('is outcome collected when every source collected', () => {
    const entry = buildCollectionPassAudit(context, {
      ...input,
      sourceOutcomes: [{ collectorKey: 'loki_logs', status: 'collected' }],
    });
    expect(entry.outcome).toBe('collected');
  });
});
