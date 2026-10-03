import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectPass } from './collect-pass.js';
import { lokiLogsCollector } from './collectors/loki-logs.js';
import { depsFor, planFor, sourceOf, PEM_HEADER } from './test-support.js';

const T = '2026-01-01T00:30:00Z';
const SYSLOG = {
  line: 'Jan  1 00:30:00 host app[123]: ERROR payment for bob@corp.com failed',
  timestamp: T,
  locator: 'loki:syslog:1',
};

async function run(records: unknown[], overrides: Parameters<typeof depsFor>[0] = {}) {
  const deps = depsFor({ loki_logs: lokiLogsCollector(sourceOf(records)), ...overrides });
  return { deps, batch: await collectPass(planFor(['loki_logs']), deps) };
}

describe('a log format the ruleset does not recognise is withheld (003 T019, T020, FR-009, SC-003)', () => {
  it('crosses as a collection_gap carrying only localRef, itemClass, reasonCode, collectorKey, observedAt', async () => {
    const { batch } = await run([SYSLOG]);
    expect(batch.items).toHaveLength(1);
    const gap = batch.items[0]!.evidence;
    expect(gap).toMatchObject({
      kind: 'collection_gap',
      withheldByRedaction: true,
      reasonCode: 'redaction_withheld',
      itemClass: 'error_signature',
      collectorKey: 'loki_logs',
      observedAt: '2026-01-01T00:30:00.000Z',
    });
    expect(gap.kind === 'collection_gap' && gap.localRef).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is never truncated and sent: no excerpt, no remnant, not one byte of the line', async () => {
    const { batch } = await run([SYSLOG]);
    expect(batch.items[0]!.excerpt).toBeUndefined();
    const bytes = JSON.stringify(batch);
    for (const fragment of ['bob', 'corp.com', 'payment', 'app[123]', 'Jan  1']) {
      expect(bytes).not.toContain(fragment);
    }
  });

  it('is recorded in the source outcome as withheld with its reason — nothing disappears without a record', async () => {
    const { batch } = await run([SYSLOG]);
    expect(batch.sourceOutcomes[0]).toMatchObject({
      status: 'withheld',
      reasonCode: 'redaction_withheld',
      itemCount: 0,
    });
  });

  it('keeps the original plane-local under the gap localRef, with its source locator', async () => {
    const { batch, deps } = await run([SYSLOG]);
    const gap = batch.items[0]!.evidence;
    const localRef = gap.kind === 'collection_gap' ? gap.localRef! : '';
    const entry = deps.ledger.resolve(localRef)!;
    expect(entry.original).toBe(SYSLOG.line);
    expect(entry.sourceLocator).toBe('loki:syslog:1');
    expect(entry.kind).toBe('withheld');
    expect(readdirSync(deps.ledgerDir)).toEqual([`${localRef}.json`]);
    expect(
      JSON.parse(readFileSync(join(deps.ledgerDir, `${localRef}.json`), 'utf8')).original,
    ).toContain('bob@corp.com');
  });

  it('withholds every item derived from a record that must be withheld, not only the one with an excerpt', async () => {
    const record = {
      line: `${T} ERROR TypeError: boom\n    at charge (/srv/app/src/billing/charge.ts:42:11)\n${PEM_HEADER}`,
      timestamp: T,
      locator: 'loki:2',
    };
    const { batch } = await run([record]);
    expect(batch.items.map((i) => i.evidence.kind)).toEqual(['collection_gap', 'collection_gap']);
    expect(JSON.stringify(batch)).not.toContain('charge.ts');
  });

  it('withholds everything when the ruleset version is one this image does not know (a disabled ruleset)', async () => {
    const good = {
      line: `${T} ERROR TypeError: Cannot read properties of undefined`,
      timestamp: T,
      locator: 'l',
    };
    const deps = {
      ...depsFor({ loki_logs: lokiLogsCollector(sourceOf([good])) }),
      redactor: undefined,
    };
    const batch = await collectPass(planFor(['loki_logs'], { redactionRulesetVersion: 99 }), deps);
    expect(batch.items.map((i) => i.evidence.kind)).toEqual(['collection_gap']);
    expect(batch.items[0]!.redactionRulesetVersion).toBe(99);
  });

  it('names the detector that failed, so a gap says which rule — not just "redaction failed" (R-07a)', async () => {
    const card = {
      line: `${T} ERROR charge failed card 4242 4242 4242 4242`,
      timestamp: T,
      locator: 'l',
    };
    const { batch } = await run([card]);
    const gap = batch.items[0]!.evidence;
    expect(gap.kind === 'collection_gap' && gap.detector).toBe('payment_instrument');
  });
});

describe('a source that throws is a status, never an exception or a quoted message (003 FR-015)', () => {
  it('reports unavailable/source_unreachable, copies nothing of the error, and tells the hook the name only', async () => {
    const heard: string[] = [];
    const exploding = {
      key: 'loki_logs' as const,
      collect: async () => {
        throw new Error('connect ECONNREFUSED while reading line from jane@example.com');
      },
    };
    const deps = {
      ...depsFor({ loki_logs: exploding }),
      onSourceError: (k: string, n: string) => heard.push(`${k}:${n}`),
    };
    const batch = await collectPass(planFor(['loki_logs']), deps);
    expect(batch.sourceOutcomes[0]).toMatchObject({
      status: 'unavailable',
      reasonCode: 'source_unreachable',
    });
    expect(JSON.stringify(batch)).not.toContain('jane@example.com');
    expect(heard).toEqual(['loki_logs:Error']);
  });
});
