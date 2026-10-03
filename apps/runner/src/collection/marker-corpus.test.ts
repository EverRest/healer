import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectPass } from './collect-pass.js';
import { configFlagsCollector } from './collectors/config-flags.js';
import { gitlabCommitsCollector } from './collectors/gitlab-commits.js';
import { lokiLogsCollector } from './collectors/loki-logs.js';
import { otelTracesCollector } from './collectors/otel-traces.js';
import type { Redactor } from './redaction/redactor.js';
import { depsFor, planFor, sourceOf, PEM_HEADER } from './test-support.js';

/**
 * `make context-marker-corpus` (003 T016, FR-007, SC-001, quickstart 3): logs, traces, config and
 * commits seeded with known PII markers and secrets, one full collection, then every crossed byte
 * — the whole serialised batch — searched for every marker. A marker found is a build failure.
 *
 * The corpus is seeded so that each marker sits in a place a *different* defence has to catch:
 * a detector (email, card, token, key), the default-deny on free text (a person's name), the
 * shape's closed field list (a config value, a commit message, a diff, a span attribute) and the
 * capture bound (a marker far into a huge record).
 */
const MARKERS = [
  'jane.doe@example.com',
  'jane.doe',
  '4242 4242 4242 4242',
  '4242424242424242',
  'Sup3rS3cret',
  'abc123secret',
  'Alice',
  'Johnson',
  '10.20.30.41',
  'PRIVATE KEY',
  'MIIEowIBAAKCAQEA',
  '123-45-6789',
  'bob@corp.com',
  'hunter2-config-secret',
  'sk-live-ABCDEFGHIJKLMNOPQRSTUV',
  'fix: jane.doe password reset hack',
  'diff-secret-9',
  'ATTR-SECRET-MARKER-77',
  'TAIL-OF-A-HUGE-RECORD-MARKER',
  'FILE-CONTENT-MARKER',
];

const T = '2026-01-01T00:30:00Z';
const LOGS = [
  {
    line: `{"level":"error","message":"Failed to charge card 4242 4242 4242 4242 for jane.doe@example.com"}`,
    timestamp: T,
    locator: 'loki:1',
  },
  {
    line: `${T} ERROR TypeError: Cannot read properties of undefined (reading 'id') for user jane.doe@example.com\n    at charge (/srv/app/src/billing/charge.ts:42:11)\n    at /srv/app/src/api/users.ts:10:5`,
    timestamp: T,
    locator: 'loki:2',
  },
  {
    line: `${T} ERROR Login failed for Alice Johnson from 10.20.30.41 token=abc123secret`,
    timestamp: T,
    locator: 'loki:3',
  },
  {
    line: `Jan  1 00:30:00 host app[123]: ERROR something with bob@corp.com`,
    timestamp: T,
    locator: 'loki:4',
  },
  {
    line: `${T} ERROR key load failed ${PEM_HEADER}\nMIIEowIBAAKCAQEA`,
    timestamp: T,
    locator: 'loki:5',
  },
  {
    line: `${T} ERROR connection refused postgres://app:Sup3rS3cret@db.internal:5432/orders`,
    timestamp: T,
    locator: 'loki:6',
  },
  { line: `${T} ERROR lookup failed for 123-45-6789`, timestamp: T, locator: 'loki:7' },
  { line: `${T} ERROR sk-live-ABCDEFGHIJKLMNOPQRSTUV rejected`, timestamp: T, locator: 'loki:8' },
  {
    line: `${T} ERROR OutOfMemoryError ${'cannot read '.repeat(2000)} TAIL-OF-A-HUGE-RECORD-MARKER`,
    timestamp: T,
    locator: 'loki:9',
  },
];
const TRACES = [
  {
    spans: [
      {
        name: 'GET /users/{id}',
        durationMs: 12,
        serviceEdge: 'api->db',
        statusCode: '500',
        attributes: { token: 'ATTR-SECRET-MARKER-77' },
      },
    ],
    observedAt: T,
    locator: 'otel:1',
  },
  {
    spans: [
      {
        name: 'GET /users/jane.doe@example.com',
        durationMs: 3,
        serviceEdge: 'api->db',
        statusCode: '404',
      },
    ],
    observedAt: T,
    locator: 'otel:2',
  },
];
const CONFIG = [
  {
    keyPath: 'db.password',
    value: 'hunter2-config-secret',
    declaringComponent: 'api',
    locator: 'cfg:1',
  },
  { keyPath: 'flags.new_checkout', value: true, locator: 'cfg:2' },
  { keyPath: 'api.key', value: 'sk-live-ABCDEFGHIJKLMNOPQRSTUV', locator: 'cfg:3' },
];
const COMMITS = [
  {
    sha: '3f9a6b2c1d0e4f5a6b7c8d9e0f1a2b3c4d5e6f70',
    authorHandle: 'jdoe',
    committedAt: T,
    changedPaths: ['src/billing/charge.ts'],
    message: 'fix: jane.doe password reset hack',
    diff: '+password = "diff-secret-9"',
    content: 'FILE-CONTENT-MARKER',
    locator: 'gl:1',
  },
];

function collectors() {
  return {
    loki_logs: lokiLogsCollector(sourceOf(LOGS)),
    otel_traces: otelTracesCollector(sourceOf(TRACES)),
    config_flags: configFlagsCollector(sourceOf(CONFIG)),
    gitlab_commits: gitlabCommitsCollector(sourceOf(COMMITS)),
  };
}
const PLAN = planFor(['loki_logs', 'otel_traces', 'config_flags', 'gitlab_commits']);

function crossedBytes(batch: unknown): string {
  return JSON.stringify(batch);
}

describe('seeded-marker corpus (003 T016, SC-001)', () => {
  it('lets 0 markers cross, in any byte of a full collection', async () => {
    const batch = await collectPass(PLAN, depsFor(collectors()));
    const bytes = crossedBytes(batch);
    for (const marker of MARKERS) {
      expect(bytes, `marker leaked across the boundary: ${marker}`).not.toContain(marker);
    }
  });

  it('is not vacuous: the corpus reaches the pipeline and what survives is structural', async () => {
    const deps = depsFor(collectors());
    const batch = await collectPass(PLAN, deps);
    const kinds = new Set(batch.items.map((i) => i.evidence.kind));
    expect(kinds).toContain('error_signature');
    expect(kinds).toContain('stack_frame');
    expect(kinds).toContain('trace_shape');
    expect(kinds).toContain('config_key_ref');
    expect(kinds).toContain('commit_ref');
    expect(kinds).toContain('collection_gap');
    // a clean template with an email crosses with the email replaced by a pseudonym
    expect(batch.items.some((i) => /<email:[0-9a-f]{8}>/.test(i.excerpt?.text ?? ''))).toBe(true);
    // the originals are resolvable inside the plane, where they belong
    const files = readdirSync(deps.ledgerDir).map((f) =>
      readFileSync(join(deps.ledgerDir, f), 'utf8'),
    );
    expect(files.some((f) => f.includes('jane.doe@example.com'))).toBe(true);
    expect(files.some((f) => f.includes('PRIVATE KEY'))).toBe(true);
  });

  it('would catch a leak: the same corpus through a redactor that clears everything leaks markers', async () => {
    const deps = depsFor(collectors());
    const leaky = {
      screen: () => undefined,
      scrubShape: (value: unknown) => ({ status: 'clear', value }),
      clearExcerpt: (text: string) => ({
        status: 'clear',
        text: text.slice(0, 500),
        truncated: false,
        redactionDominated: false,
      }),
    } as unknown as Redactor;
    const bytes = crossedBytes(await collectPass(PLAN, { ...deps, redactor: leaky }));
    expect(MARKERS.filter((m) => bytes.includes(m)).length).toBeGreaterThan(3);
  });
});
