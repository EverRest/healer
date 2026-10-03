import { describe, expect, it } from 'vitest';
import { collectPass } from './collect-pass.js';
import { lokiLogsCollector } from './collectors/loki-logs.js';
import { depsFor, planFor, sourceOf } from './test-support.js';

const T = '2026-01-01T00:30:00Z';

async function run(line: string) {
  const deps = depsFor({
    loki_logs: lokiLogsCollector(sourceOf([{ line, timestamp: T, locator: 'loki:big:1' }])),
  });
  return { deps, batch: await collectPass(planFor(['loki_logs']), deps) };
}

describe('redaction-dominated items are kept, not withheld (003 T027, R-08, quickstart 9)', () => {
  it('keeps the structured derivatives and flags redactionDominated, with a plane-local reference', async () => {
    const { batch, deps } = await run(
      `${T} ERROR TypeError: Alice Johnson from Acme Corp\n    at f (/srv/app/src/a.ts:1:2)`,
    );
    const [signature, frame] = batch.items;
    expect(signature!.evidence).toMatchObject({
      kind: 'error_signature',
      exceptionType: 'TypeError',
      frames: ['src/a.ts:1'],
    });
    expect(signature!.redactionDominated).toBe(true);
    expect(signature!.excerpt).toBeUndefined();
    expect(frame!.evidence).toMatchObject({ kind: 'stack_frame', path: 'src/a.ts', line: 1 });
    expect(deps.ledger.resolve(signature!.localRef!)?.kind).toBe('reduced');
    expect(JSON.stringify(batch)).not.toContain('Alice');
  });

  it('is not a gap: a reader is told to look locally, not that nothing was there', async () => {
    const { batch } = await run(`${T} ERROR TypeError: Alice Johnson`);
    expect(batch.items.some((i) => i.evidence.kind === 'collection_gap')).toBe(false);
    expect(batch.sourceOutcomes[0]!.status).toBe('collected');
  });
});

describe('a 40 MB payload never crosses and never inlines (003 T028, FR-013, quickstart 43)', () => {
  const FORTY_MB = 40 * 1024 * 1024;
  const body = 'cannot read '.repeat(Math.ceil(FORTY_MB / 12));
  const line = `${T} ERROR OutOfMemoryError ${body} TAIL-MARKER`;

  it('crosses as a bounded redacted excerpt plus a plane-local reference', async () => {
    const started = Date.now();
    const { batch, deps } = await run(line);
    expect(Date.now() - started).toBeLessThan(5000);
    const item = batch.items[0]!;
    expect(item.excerpt!.truncated).toBe(true);
    expect(item.excerpt!.text.length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(batch).length).toBeLessThan(5_000);
    expect(deps.ledger.resolve(item.localRef!)?.originalTruncated).toBe(true);
    expect(JSON.stringify(batch)).not.toContain('TAIL-MARKER');
  });
});
