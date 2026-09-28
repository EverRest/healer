import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { withCorrelation } from '@healer/shared';
import { describe, expect, it } from 'vitest';
import { issueResolvedEvent, resolutionForCause, type IssueResolution } from './events.js';
import type { Issue } from './issue.js';
import { transitionIssue, type IssueEventCause } from './state-machine.js';

/**
 * `IssueResolved` (001 T054/T057, contracts/events.md "IssueResolved and its three kinds", C-09,
 * quickstart 24). "Resolved means verified": only production verification (`remediated`, `fixed`)
 * or a human close (`self_resolved`) may emit it — never a merge, never a deploy — and
 * `self_resolved` carries no verification evidence, because nobody verified anything.
 */
describe('issueResolvedEvent (contracts/events.md)', () => {
  it('self_resolved carries an empty verification evidence list and no verifiedAt', () => {
    const event = withCorrelation('corr-1', () =>
      issueResolvedEvent('tenant-1', 'issue-1', { kind: 'self_resolved' }),
    );
    expect(event).toMatchObject({
      name: 'IssueResolved',
      tenantId: 'tenant-1',
      subjectId: 'issue-1',
      correlationId: 'corr-1',
      payload: { resolutionKind: 'self_resolved', verificationEvidenceIds: [] },
    });
    expect(event.payload).not.toHaveProperty('verifiedAt');
  });

  it('remediated and fixed carry their verification evidence and the time it was verified', () => {
    for (const kind of ['remediated', 'fixed'] as const) {
      const event = withCorrelation('corr-1', () =>
        issueResolvedEvent('tenant-1', 'issue-1', {
          kind,
          verifiedAt: new Date('2026-01-01T00:00:00Z'),
          verificationEvidenceIds: ['ev-1', 'ev-2'],
        }),
      );
      expect(event.payload).toEqual({
        resolutionKind: kind,
        verifiedAt: '2026-01-01T00:00:00.000Z',
        verificationEvidenceIds: ['ev-1', 'ev-2'],
      });
    }
  });

  it('refuses to build an event outside a correlated scope', () => {
    expect(() => issueResolvedEvent('tenant-1', 'issue-1', { kind: 'self_resolved' })).toThrow(
      /correlated scope/,
    );
  });

  it('cannot express a self_resolved with evidence, or a verified kind without it — checked by tsc', () => {
    // Never called: this test exists for the `@ts-expect-error` directives. `tsc --build` fails
    // with "unused directive" the moment either shape becomes representable again.
    const unrepresentable: IssueResolution[] = [
      // @ts-expect-error self_resolved must not carry verification evidence
      { kind: 'self_resolved', verificationEvidenceIds: ['ev-1'] },
      // @ts-expect-error a verified resolution must name its evidence
      { kind: 'remediated', verifiedAt: new Date() },
      // @ts-expect-error an empty evidence list is not verification
      { kind: 'fixed', verifiedAt: new Date(), verificationEvidenceIds: [] },
    ];
    expect(unrepresentable).toHaveLength(3);
  });
});

/** Compile-time exhaustive: adding a cause to `IssueEventCause` breaks this until it is listed. */
const CAUSES = Object.keys({
  ingestion: 0,
  agent: 0,
  human: 0,
  policy: 0,
  system: 0,
} satisfies Record<IssueEventCause, unknown>) as IssueEventCause[];

const OPEN_ISSUE: Issue = {
  id: 'issue-1',
  tenantId: 'tenant-1',
  kind: 'production_incident',
  componentId: null,
  environment: 'prod',
  severity: 'high',
  state: 'investigating',
  fingerprint: 'fp1',
  rulesetVersion: 1,
  occurrenceCount: 1n,
  firstSeenAt: new Date('2026-01-01T00:00:00Z'),
  lastSeenAt: new Date('2026-01-01T00:00:00Z'),
  staleAt: null,
  resolvedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

describe('the publish site and the state machine agree on who may resolve (001 T057, C-09)', () => {
  it('a human close is self_resolved; every other cause has no resolution to publish', () => {
    expect(resolutionForCause('human')).toEqual({ kind: 'self_resolved' });
    for (const cause of CAUSES.filter((c) => c !== 'human')) {
      expect(() => resolutionForCause(cause)).toThrow(/no verified-resolution emitter/);
    }
  });

  it('exactly the causes the state machine lets reach resolved have a resolution — widen one and not the other and this fails', () => {
    const machineAllows = (cause: IssueEventCause): boolean => {
      try {
        transitionIssue(OPEN_ISSUE, 'resolved', cause, 'x');
        return true;
      } catch {
        return false;
      }
    };
    const publishSiteHas = (cause: IssueEventCause): boolean => {
      try {
        resolutionForCause(cause);
        return true;
      } catch {
        return false;
      }
    };
    for (const cause of CAUSES) {
      expect({ cause, publishSite: publishSiteHas(cause) }).toEqual({
        cause,
        publishSite: machineAllows(cause),
      });
    }
  });
});

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

/** Production source and migrations: every non-test, non-generated, non-declaration file that
 *  could construct or publish an event, in any JS/TS module flavour, plus SQL. */
const SCANNED_ROOTS = ['apps', 'packages', 'scripts', 'test', 'prisma'];
const SCANNED_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.sql'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      return ['node_modules', 'dist', 'generated'].includes(entry.name) ? [] : sourceFiles(path);
    }
    const isSource =
      SCANNED_EXTENSIONS.some((ext) => entry.name.endsWith(ext)) &&
      !/\.test\.[mc]?[jt]s$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts');
    return isSource ? [path] : [];
  });
}

/** Comments name the event all the time (this feature documents it); code must not. Crude on
 *  purpose — it may strip a `//` inside a string, which can only hide text, never invent it. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(path.endsWith('.sql') ? /--.*$/gm : /\/\/.*$/gm, '');
}

const SOURCES = SCANNED_ROOTS.flatMap((root) => sourceFiles(`${REPO_ROOT}${root}`)).map((path) => ({
  path: path.slice(REPO_ROOT.length),
  code: code(path),
}));

describe('IssueResolved has exactly one producer (001 T054, quickstart 24)', () => {
  const EVENTS = 'packages/domain/issues/src/domain/events.ts';
  const REPOSITORY = 'packages/domain/issues/src/infrastructure/prisma-issue-repository.ts';
  const OUTBOX_STORE = 'packages/events/src/infrastructure/prisma-outbox.ts';

  const filesMatching = (needle: RegExp): string[] =>
    SOURCES.filter(({ code: text }) => needle.test(text)).map(({ path }) => path);
  const countIn = (path: string, needle: RegExp): number =>
    SOURCES.find((s) => s.path === path)?.code.match(needle)?.length ?? 0;

  it('scans the roots it claims to (a scan that finds nothing proves nothing)', () => {
    expect(SOURCES.map((s) => s.path)).toEqual(
      expect.arrayContaining([EVENTS, REPOSITORY, OUTBOX_STORE, 'test/containers.ts']),
    );
    expect(SOURCES.some((s) => s.path.endsWith('.sql'))).toBe(true);
    expect(SOURCES.some((s) => s.path.endsWith('.mjs'))).toBe(true);
  });

  it('the event name appears in code in one file — whatever the quoting or template', () => {
    // Bare word, so 'IssueResolved', "IssueResolved" and `IssueResolved` all match.
    expect(filesMatching(/\bIssueResolved\b/)).toEqual([EVENTS]);
  });

  it('the payload field is built in one file', () => {
    expect(filesMatching(/\bresolutionKind\b/)).toEqual([EVENTS]);
  });

  it('the builder is referenced by name in two files only, never aliased or re-exported', () => {
    expect(filesMatching(/\bissueResolvedEvent\b/).sort()).toEqual([EVENTS, REPOSITORY]);
    expect(filesMatching(/\bissueResolvedEvent\s+as\b/)).toEqual([]);
    expect(filesMatching(/export\s*\{[^}]*\bissueResolvedEvent\b/)).toEqual([]);
  });

  it('and called from one place, once — a transition that lands on resolved', () => {
    expect(countIn(REPOSITORY, /\bissueResolvedEvent\(/g)).toBe(1);
  });

  it('nothing but the outbox store writes to the outbox — no hand-built row, ORM or raw SQL', () => {
    const writes =
      /\boutbox\s*\.\s*(create|createMany|upsert|update)\b|insert\s+into\s+["']?events["']?\s*\.\s*["']?outbox/i;
    // `update` is the drain marking rows published, also the store's; anything else is a producer.
    expect(filesMatching(writes)).toEqual([OUTBOX_STORE]);
  });
});
