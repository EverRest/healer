import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { collectPass } from './collect-pass.js';
import { configFlagsCollector } from './collectors/config-flags.js';
import { lokiLogsCollector } from './collectors/loki-logs.js';
import { otelTracesCollector } from './collectors/otel-traces.js';
import type { Collector } from './collectors/types.js';
import { FsWithholdingLedger } from './withholding-ledger.js';
import { depsFor, planFor, sourceOf, PEM_HEADER } from './test-support.js';

const T = '2026-01-01T00:30:00Z';
const loki = (lines: string[]) =>
  lokiLogsCollector(sourceOf(lines.map((line, i) => ({ line, timestamp: T, locator: `l${i}` }))));
const run = (
  collectors: Parameters<typeof depsFor>[0],
  keys: Parameters<typeof planFor>[0],
  plan = {},
) => collectPass(planFor(keys, plan), depsFor(collectors));

describe('review regressions — structural fields', () => {
  const trace = (name: string, serviceEdge = 'api->db') =>
    sourceOf([
      {
        spans: [{ name, durationMs: 1, serviceEdge, statusCode: '500' }],
        observedAt: T,
        locator: 't',
      },
    ]);
  const names = async (name: string, edge?: string) => {
    const batch = await run({ otel_traces: otelTracesCollector(trace(name, edge)) }, [
      'otel_traces',
    ]);
    return { batch, bytes: JSON.stringify(batch) };
  };

  it('withholds a span name that is not a route template (a person in the path)', async () => {
    const { batch, bytes } = await names('GET /users/alice-johnson/orders');
    expect(batch.items.map((i) => i.evidence.kind)).toEqual(['collection_gap']);
    expect(bytes).not.toContain('alice');
    expect((await names('checkout for John Smith')).bytes).not.toContain('John');
  });

  it('keeps a route template and replaces numeric ids, uuids and ips in names and edges', async () => {
    const ok = await names('GET /users/{id}/orders');
    expect(ok.batch.items[0]!.evidence.kind).toBe('trace_shape');
    const ids = await names(
      'GET /users/12345678/0190b7a0-1111-7222-8333-444455556666',
      '10.20.30.41->10.20.30.42',
    );
    expect(ids.batch.items[0]!.evidence.kind).toBe('trace_shape');
    for (const leaked of ['12345678', '1111-7222', '10.20.30.41'])
      expect(ids.bytes).not.toContain(leaked);
  });
});

describe('review regressions — the log parser', () => {
  it('does not stall on a hostile stack line (no catastrophic backtracking)', async () => {
    const started = Date.now();
    await run({ loki_logs: loki([`${T} ERROR TypeError: x\n    at${' '.repeat(6000)}x`]) }, [
      'loki_logs',
    ]);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('collects a record with a microsecond timestamp instead of withholding it as an unclassifiable id', async () => {
    const batch = await run(
      {
        loki_logs: loki([
          `2026-01-01T00:30:00.123456Z ERROR TypeError: Cannot read properties of undefined\n    at f (/srv/app/src/a.ts:1:2)`,
        ]),
      },
      ['loki_logs'],
    );
    expect(batch.items.map((i) => i.evidence.kind)).toEqual(['error_signature', 'stack_frame']);
  });

  it('skips a frame with line 0 rather than failing the whole pass at egress', async () => {
    const batch = await run(
      {
        loki_logs: loki([
          `${T} ERROR TypeError: x\n    at f (/srv/app/src/a.ts:0:0)\n    at g (/srv/app/src/b.ts:2:1)`,
        ]),
      },
      ['loki_logs'],
    );
    expect(batch.items.filter((i) => i.evidence.kind === 'stack_frame')).toHaveLength(1);
  });
});

describe('review regressions — collectPass keeps its contract', () => {
  it('turns an item the schema refuses into a schema_rejected gap, not an exception that discards the pass', async () => {
    const bad: Collector = {
      key: 'config_flags',
      collect: async () => ({
        candidates: [
          {
            kind: 'candidate',
            itemClass: 'stack_frame',
            evidence: {
              kind: 'stack_frame',
              path: 'src/a.ts',
              symbolName: 'f',
              line: 0,
              frameIndex: 0,
            },
            observedAt: new Date(T),
            sourceLocator: 'x',
          },
        ],
        capped: false,
      }),
    };
    const batch = await run({ config_flags: bad, loki_logs: loki([`${T} ERROR TypeError: x`]) }, [
      'config_flags',
      'loki_logs',
    ]);
    expect(batch.items.filter((i) => i.evidence.kind === 'collection_gap')).toHaveLength(1);
    expect(batch.sourceOutcomes[0]).toMatchObject({
      status: 'partial',
      reasonCode: 'schema_rejected',
    });
    expect(batch.sourceOutcomes[1]!.status).toBe('collected');
  });

  it('leaves no items behind for a source that failed halfway (a ledger write error)', async () => {
    const deps = depsFor({
      loki_logs: loki([`${T} ERROR key ${PEM_HEADER}`, `${T} ERROR key2 ${PEM_HEADER}`]),
    });
    let writes = 0;
    const flaky = {
      record: (e: Parameters<FsWithholdingLedger['record']>[0]) => {
        if (++writes === 2) throw new Error('ENOSPC');
        return deps.ledger.record(e);
      },
      pruneExpired: () => 0,
    } as unknown as FsWithholdingLedger;
    const batch = await collectPass(planFor(['loki_logs']), { ...deps, ledger: flaky });
    expect(batch.items).toEqual([]);
    expect(batch.sourceOutcomes[0]).toMatchObject({ status: 'unavailable', itemCount: 0 });
  });

  it('enforces maxItemsPerCollector on unrecognised records and reports the truncation', async () => {
    const junk = Array.from({ length: 50 }, (_, i) => ({ nonsense: i }));
    const deps = depsFor({ config_flags: configFlagsCollector(sourceOf(junk)) });
    const batch = await collectPass(
      planFor(['config_flags'], { budget: { maxWallClockMs: 1000, maxItemsPerCollector: 2 } }),
      deps,
    );
    expect(batch.items).toHaveLength(2);
    expect(readdirSync(deps.ledgerDir)).toHaveLength(2);
    expect(batch.sourceOutcomes[0]!.truncated).toBe(true);
  });

  it('writes one ledger entry per withheld record, shared by every item derived from it', async () => {
    const record = `${T} ERROR TypeError: x\n${Array.from({ length: 10 }, (_, i) => `    at f${i} (/srv/app/src/a${i}.ts:1:1)`).join('\n')}\n${PEM_HEADER}`;
    const deps = depsFor({ loki_logs: loki([record]) });
    const batch = await collectPass(planFor(['loki_logs']), deps);
    expect(batch.items).toHaveLength(11);
    expect(readdirSync(deps.ledgerDir)).toHaveLength(1);
    const refs = new Set(
      batch.items.map((i) => (i.evidence.kind === 'collection_gap' ? i.evidence.localRef : '')),
    );
    expect(refs.size).toBe(1);
  });

  it('keeps the whole record as the original when the ruleset is unknown (never a blank)', async () => {
    const deps = {
      ...depsFor({
        loki_logs: loki([`${T} ERROR TypeError: x\n    at f (/srv/app/src/a.ts:1:1)`]),
      }),
      redactor: undefined,
    };
    const batch = await collectPass(planFor(['loki_logs']), deps);
    const gap = batch.items[0]!.evidence;
    const ref = gap.kind === 'collection_gap' ? gap.localRef! : '';
    expect(deps.ledger.resolve(ref)?.original).toContain('at f (/srv/app/src/a.ts');
  });

  it('prunes expired ledger entries at the start of a pass — retention is enforced, not merely hidden', async () => {
    const deps = depsFor({});
    let now = new Date('2026-01-01T00:00:00Z');
    const ledger = new FsWithholdingLedger(deps.ledgerDir, () => now, 1000);
    ledger.record({
      kind: 'withheld',
      collectorKey: 'loki_logs',
      itemClass: 'error_signature',
      sourceLocator: 'x',
      original: 'old secret',
      observedAt: now,
    });
    now = new Date('2026-01-01T00:01:00Z');
    await collectPass(planFor(['loki_logs']), { ...deps, ledger });
    expect(readdirSync(deps.ledgerDir)).toEqual([]);
  });
});
