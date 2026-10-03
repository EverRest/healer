import { describe, expect, it } from 'vitest';
import {
  CollectionResultBatch,
  COLLECTION_CONTRACT_VERSION,
  ControlPlaneDirective,
  EXCERPT_MAX_CHARS,
  validateResultBatchEgress,
  validateResultBatchIngress,
} from './index.js';

const PASS_ID = '0190b7a0-0000-7000-8000-000000000001';
const ISSUE_ID = '0190b7a0-0000-7000-8000-000000000002';

const SIGNATURE = {
  kind: 'error_signature',
  exceptionType: 'TypeError',
  frames: ['src/a.ts'],
  component: 'api',
  environment: 'production',
};

function item(overrides: Record<string, unknown> = {}) {
  return {
    evidence: SIGNATURE,
    collectorKey: 'loki_logs',
    observedAt: '2026-01-01T00:00:00Z',
    redactionDominated: false,
    redactionRulesetVersion: 1,
    ...overrides,
  };
}

function batch(overrides: Record<string, unknown> = {}) {
  return {
    passId: PASS_ID,
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
        durationMs: 12,
      },
    ],
    items: [item()],
    ...overrides,
  };
}

describe('collection result batch (003 T006, T007, T008)', () => {
  it('accepts a conforming batch on both sides', () => {
    expect(validateResultBatchEgress(batch()).ok).toBe(true);
    expect(validateResultBatchIngress(batch()).ok).toBe(true);
  });

  // T007 — seen to fail first: the closed shape set carries no free-form field.
  const FREE_FORM = batch({
    items: [
      item({ evidence: { ...SIGNATURE, message: 'user jane@example.com failed to log in' } }),
    ],
  });

  it('refuses a free-form string field at ingress with BOUNDARY_SCHEMA_REJECTED semantics', () => {
    const result = validateResultBatchIngress(FREE_FORM);
    expect(result.ok).toBe(false);
    expect(result.schemaErrorPaths?.length).toBeGreaterThan(0);
  });

  it('refuses the same payload at egress, before it is sent', () => {
    expect(validateResultBatchEgress(FREE_FORM).ok).toBe(false);
  });

  it('refuses an envelope-level free-form field', () => {
    expect(validateResultBatchIngress(batch({ items: [item({ rawBody: 'GET /x' })] })).ok).toBe(
      false,
    );
  });

  it('bounds the excerpt — an unbounded string here would be the escape hatch', () => {
    const over = item({
      excerpt: { text: 'x'.repeat(EXCERPT_MAX_CHARS + 1), truncated: false },
    });
    expect(validateResultBatchIngress(batch({ items: [over] })).ok).toBe(false);
    const within = item({ excerpt: { text: 'x'.repeat(EXCERPT_MAX_CHARS), truncated: true } });
    expect(validateResultBatchIngress(batch({ items: [within] })).ok).toBe(true);
  });

  it('never echoes a rejected value or a payload-chosen key name in the error paths', () => {
    const marker = 'jane@example.com-SECRET-KEY';
    const hostile = batch({
      items: [
        item({
          evidence: {
            kind: 'tool_output_summary',
            toolName: 'grep',
            outcome: 'ok',
            fields: { [marker]: 'y'.repeat(501) },
          },
        }),
      ],
    });
    const result = validateResultBatchIngress(hostile);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.schemaErrorPaths)).not.toContain('jane@example.com');
    expect(JSON.stringify(result.schemaErrorPaths)).not.toContain('SECRET');
    expect(JSON.stringify(result.schemaErrorPaths)).not.toContain('yyyy');
  });

  it('rejects a collected outcome with a reason and a non-collected outcome without one', () => {
    const outcome = (status: string, reasonCode?: string) => ({
      collectorKey: 'loki_logs',
      status,
      ...(reasonCode ? { reasonCode } : {}),
      itemCount: 0,
      truncated: false,
      durationMs: 1,
    });
    expect(
      validateResultBatchIngress(batch({ sourceOutcomes: [outcome('collected', 'timeout')] })).ok,
    ).toBe(false);
    expect(validateResultBatchIngress(batch({ sourceOutcomes: [outcome('unavailable')] })).ok).toBe(
      false,
    );
    expect(
      validateResultBatchIngress(
        batch({ sourceOutcomes: [outcome('unavailable', 'auth_revoked')] }),
      ).ok,
    ).toBe(true);
  });

  it('rejects an unknown collector key — undeclared sources are not representable (R-12)', () => {
    expect(validateResultBatchIngress(batch({ items: [item({ collectorKey: 'shell' })] })).ok).toBe(
      false,
    );
  });

  it('keeps a withheld gap structural: reason code, item class, localRef, no prose', () => {
    const gap = {
      kind: 'collection_gap',
      what: 'loki_logs',
      why: 'redaction_withheld',
      withheldByRedaction: true,
      collectorKey: 'loki_logs',
      reasonCode: 'redaction_withheld',
      itemClass: 'error_signature',
      localRef: '0190b7a0-0000-7000-8000-0000000000aa',
      observedAt: '2026-01-01T00:00:00Z',
    };
    expect(validateResultBatchIngress(batch({ items: [item({ evidence: gap })] })).ok).toBe(true);
    // free text in `what` / `why` is how a raw line would ride a gap
    const prose = { ...gap, what: 'GET /users/jane@example.com 500' };
    expect(validateResultBatchIngress(batch({ items: [item({ evidence: prose })] })).ok).toBe(
      false,
    );
  });

  it('is one schema: both validators execute CollectionResultBatch (R-02)', () => {
    expect(CollectionResultBatch.safeParse(batch()).success).toBe(true);
  });
});

describe('collection_plan directive (003 T006)', () => {
  const plan = (overrides: Record<string, unknown> = {}) => ({
    kind: 'collection_plan',
    passId: PASS_ID,
    issueRef: ISSUE_ID,
    planDigest: 'sha256:abc',
    passOrdinal: 0,
    contractVersion: 1,
    window: { from: '2026-01-01T00:00:00Z', to: '2026-01-01T01:00:00Z' },
    collectors: [
      {
        collectorKey: 'loki_logs',
        parameters: { component: 'api', environment: 'production' },
        timeoutMs: 5000,
        itemClasses: ['error_signature'],
      },
    ],
    budget: { maxWallClockMs: 30000, maxItemsPerCollector: 500 },
    redactionRulesetVersion: 1,
    ...overrides,
  });

  it('accepts a declared collector with schema-validated parameters', () => {
    expect(ControlPlaneDirective.safeParse(plan()).success).toBe(true);
  });

  it('refuses a query, an expression or a command in place of declared parameters', () => {
    const withQuery = plan({
      collectors: [
        {
          collectorKey: 'loki_logs',
          parameters: { component: 'api', environment: 'production', query: '{app=~".+"}' },
          timeoutMs: 5000,
          itemClasses: ['error_signature'],
        },
      ],
    });
    expect(ControlPlaneDirective.safeParse(withQuery).success).toBe(false);
  });

  it('keeps source_file out of pass 0 and demands a requester on a follow-up', () => {
    const sourceFile = {
      collectorKey: 'source_file',
      parameters: { paths: ['src/a.ts'] },
      timeoutMs: 5000,
      itemClasses: ['file_path'],
    };
    expect(ControlPlaneDirective.safeParse(plan({ collectors: [sourceFile] })).success).toBe(false);
    expect(
      ControlPlaneDirective.safeParse(plan({ passOrdinal: 1, collectors: [sourceFile] })).success,
    ).toBe(false);
    expect(
      ControlPlaneDirective.safeParse(
        plan({
          passOrdinal: 1,
          collectors: [sourceFile],
          requestedByStep: 'investigator',
          requestReason: 'inspect_stack_frame_source',
        }),
      ).success,
    ).toBe(true);
  });
});

describe('review regressions — the boundary refuses what it documents refusing', () => {
  it('never echoes a sender-chosen record key into the error paths, identifier-shaped or not', () => {
    const hostile = batch({
      items: [
        item({
          evidence: {
            kind: 'tool_output_summary',
            toolName: 'grep',
            outcome: 'ok',
            fields: { AKIAIOSFODNN7EXAMPLE: 'y'.repeat(501) },
          },
        }),
      ],
    });
    const paths = validateResultBatchIngress(hostile).schemaErrorPaths ?? [];
    expect(paths.length).toBeGreaterThan(0);
    expect(JSON.stringify(paths)).not.toContain('AKIA');
  });

  const sourceFile = (paths: string[]) => ({
    collectorKey: 'source_file',
    parameters: { paths },
    timeoutMs: 5000,
    itemClasses: ['file_path'],
  });
  const loki = (parameters: Record<string, unknown>) => ({
    collectorKey: 'loki_logs',
    parameters,
    timeoutMs: 5000,
    itemClasses: ['error_signature'],
  });
  const plan = (overrides: Record<string, unknown> = {}) => ({
    kind: 'collection_plan',
    passId: PASS_ID,
    issueRef: ISSUE_ID,
    planDigest: 'sha256:abc',
    passOrdinal: 0,
    contractVersion: 1,
    window: { from: '2026-01-01T00:00:00Z', to: '2026-01-01T01:00:00Z' },
    collectors: [loki({ component: 'api', environment: 'production' })],
    budget: { maxWallClockMs: 30000, maxItemsPerCollector: 500 },
    redactionRulesetVersion: 1,
    ...overrides,
  });
  const followUp = {
    passOrdinal: 1,
    requestedByStep: 'investigator',
    requestReason: 'widen_time_window',
  };
  const ok = (p: unknown) => ControlPlaneDirective.safeParse(p).success;

  it('pass 0 names neither a requester nor a reason — not one of them', () => {
    expect(ok(plan({ requestedByStep: 'investigator' }))).toBe(false);
    expect(ok(plan({ requestReason: 'widen_time_window' }))).toBe(false);
    expect(ok(plan({ passOrdinal: 1, requestedByStep: 'investigator' }))).toBe(false);
  });

  it('source_file names repository-relative paths only: no absolute path, no `..`', () => {
    for (const bad of ['../../etc/passwd', '/etc/shadow', 'src/../../x', 'a\\b']) {
      expect(ok(plan({ ...followUp, collectors: [sourceFile([bad])] })), bad).toBe(false);
    }
    expect(ok(plan({ ...followUp, collectors: [sourceFile(['src/a.ts'])] }))).toBe(true);
  });

  it('component and environment are labels, not queries', () => {
    for (const bad of ['{app=~".+"} |= "password"', 'a b', 'x'.repeat(101), 'a;drop']) {
      expect(
        ok(plan({ collectors: [loki({ component: bad, environment: 'production' })] })),
        bad,
      ).toBe(false);
    }
  });

  it('refuses an inverted window, a duplicated collector and an unbounded budget', () => {
    expect(ok(plan({ window: { from: '2026-01-02T00:00:00Z', to: '2026-01-01T00:00:00Z' } }))).toBe(
      false,
    );
    const one = loki({ component: 'api', environment: 'production' });
    expect(ok(plan({ collectors: [one, one] }))).toBe(false);
    expect(ok(plan({ budget: { maxWallClockMs: 30000, maxItemsPerCollector: 2 ** 53 - 1 } }))).toBe(
      false,
    );
    expect(ok(plan({ budget: { maxWallClockMs: 2 ** 40, maxItemsPerCollector: 500 } }))).toBe(
      false,
    );
  });
});
