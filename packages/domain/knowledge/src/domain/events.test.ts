import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enqueue, type OutboxRecord, type OutboxTransaction } from '@healer/events';
import { TenantContext, withCorrelation } from '@healer/shared';
import { describe, expect, it } from 'vitest';
import {
  documentVersionIngestedEvent,
  expectationAdoptedEvent,
  expectationAdoptionRevokedEvent,
  expectationDraftProposedEvent,
  KNOWLEDGE_EVENT_NAMES,
  knowledgeDriftFindingRaisedEvent,
} from './events.js';
import { humanActorRef } from './human-actor-ref.js';
import { CODE_FILE, readCode, REPO_ROOT, walkRepo } from '../testing/repo-scan.js';

const TENANT = '3f2c1a9e-8b7d-4c6e-9a5f-1d2e3f4a5b6c';
const ctx = TenantContext.forTrustedInternalUse(TENANT);

/** Type-checked by `tsc --build`, never invoked. */
function typeProofNeverCalled(): void {
  expectationAdoptedEvent(ctx, {
    anchorGrantId: 'g',
    expectedBehaviorVersionId: 'v',
    // @ts-expect-error a bare string is not a HumanActorRef — adoption needs the explicit construction
    actorRef: 'a',
  });
  // @ts-expect-error adoption requires actorRef (a human act) — FR-010
  expectationAdoptedEvent(ctx, { anchorGrantId: 'g', expectedBehaviorVersionId: 'v' });
  // @ts-expect-error adoption requires anchorGrantId — the grant is what makes it an anchor
  expectationAdoptedEvent(ctx, { expectedBehaviorVersionId: 'v', actorRef: 'a' });
  // @ts-expect-error a revocation without a reason is not representable
  expectationAdoptionRevokedEvent(ctx, { anchorGrantId: 'g', revokedBy: 'a' });
  // @ts-expect-error payloads are closed: no free-form field (document text) can ride along
  documentVersionIngestedEvent(ctx, { documentId: 'd', versionNo: 1, text: 'prose' });
  // @ts-expect-error tenant comes from a TenantContext, never a string
  expectationAdoptedEvent(TENANT, {
    anchorGrantId: 'g',
    expectedBehaviorVersionId: 'v',
    actorRef: 'a',
  });
  // @ts-expect-error a drift finding names at least one of the two version ids
  knowledgeDriftFindingRaisedEvent(ctx, {
    findingId: 'f',
    kind: 'constraint_value_conflict',
    issueId: 'i',
  });
}
void typeProofNeverCalled;

const build = (): ReturnType<typeof expectationAdoptedEvent>[] =>
  withCorrelation('corr-1', () => [
    expectationDraftProposedEvent(ctx, {
      expectedBehaviorId: 'eb-1',
      seedingSessionId: 's-1',
      extractionRule: 'openapi-status-codes',
    }),
    expectationAdoptedEvent(ctx, {
      anchorGrantId: 'g-1',
      expectedBehaviorVersionId: 'ebv-1',
      actorRef: humanActorRef('alice'),
    }),
    expectationAdoptionRevokedEvent(ctx, {
      anchorGrantId: 'g-1',
      revokedBy: 'bob',
      reason: 'obsolete',
    }),
    knowledgeDriftFindingRaisedEvent(ctx, {
      findingId: 'f-1',
      kind: 'document_contradicts_code',
      issueId: 'i-1',
      documentVersionId: 'dv-1',
    }),
    documentVersionIngestedEvent(ctx, {
      documentId: 'd-1',
      versionNo: 2,
      sourceModifiedAt: '2026-10-01T00:00:00.000Z',
    }),
  ]);

describe('knowledge outbox events (005 T014, retrieval-contract.md §5)', () => {
  it('each builder yields a DomainEvent with the tenant from the TenantContext and exact payloads', () => {
    const events = build();
    expect(events.map((e) => e.name)).toEqual([
      'ExpectationDraftProposed',
      'ExpectationAdopted',
      'ExpectationAdoptionRevoked',
      'KnowledgeDriftFindingRaised',
      'DocumentVersionIngested',
    ]);
    for (const e of events) {
      expect(e.tenantId).toBe(TENANT);
      expect(e.correlationId).toBe('corr-1');
    }
    expect(events[1]).toMatchObject({
      subjectId: 'g-1',
      payload: { anchorGrantId: 'g-1', expectedBehaviorVersionId: 'ebv-1', actorRef: 'alice' },
    });
    expect(events[2]!.payload).toEqual({
      anchorGrantId: 'g-1',
      revokedBy: 'bob',
      reason: 'obsolete',
    });
    expect(events[3]!.payload).toEqual({
      findingId: 'f-1',
      kind: 'document_contradicts_code',
      issueId: 'i-1',
      documentVersionId: 'dv-1',
    });
    expect(events[4]!.payload).toEqual({
      documentId: 'd-1',
      versionNo: 2,
      sourceModifiedAt: '2026-10-01T00:00:00.000Z',
    });
  });

  it('refuses to build outside a correlated scope', () => {
    expect(() =>
      expectationAdoptedEvent(ctx, {
        anchorGrantId: 'g',
        expectedBehaviorVersionId: 'v',
        actorRef: humanActorRef('a'),
      }),
    ).toThrow(/correlated scope/);
  });

  it('refuses a drift finding naming neither version at runtime too', () => {
    expect(() =>
      withCorrelation('c', () =>
        knowledgeDriftFindingRaisedEvent(ctx, {
          findingId: 'f',
          kind: 'constraint_value_conflict',
          issueId: 'i',
        } as never),
      ),
    ).toThrow(/documentVersionId or expectedBehaviorVersionId/);
  });

  it.each([null, '', 0])('refuses a drift finding whose only id is %j', (bad) => {
    for (const field of ['documentVersionId', 'expectedBehaviorVersionId']) {
      expect(() =>
        withCorrelation('c', () =>
          knowledgeDriftFindingRaisedEvent(ctx, {
            findingId: 'f',
            kind: 'constraint_value_conflict',
            issueId: 'i',
            [field]: bad,
          } as never),
        ),
      ).toThrow(/VersionId/);
    }
  });

  it('refuses a drift finding with one good id and one empty id', () => {
    expect(() =>
      withCorrelation('c', () =>
        knowledgeDriftFindingRaisedEvent(ctx, {
          findingId: 'f',
          kind: 'constraint_value_conflict',
          issueId: 'i',
          documentVersionId: 'dv',
          expectedBehaviorVersionId: '',
        } as never),
      ),
    ).toThrow(/non-empty/);
  });

  it('humanActorRef refuses an empty ref', () => {
    expect(() => humanActorRef('  ')).toThrow(/non-empty/);
  });

  it('enqueues through the outbox inside a caller-owned transaction', async () => {
    const rows: OutboxRecord[] = [];
    const tx: OutboxTransaction = {
      insertOutbox: (r) => {
        rows.push(r);
        return Promise.resolve();
      },
    };
    for (const e of build()) await enqueue(tx, e);
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.tenantId === TENANT)).toBe(true);
  });
});

/**
 * Names are unique strings across producers (§5: three producers, three names). The reader: this
 * scan of every non-test source under apps/ and packages/ for the event-name literals this
 * producer owns (any quoted occurrence, `name: '...'` or otherwise), excluding exactly this
 * package's events.ts. It also lists every `name: 'X'` event literal elsewhere to prove the walk
 * sees 004's events and that none of the foreign names is ours.
 */
const OWN_EVENTS_FILE = 'packages/domain/knowledge/src/domain/events.ts';
const FOREIGN_FORBIDDEN = [
  'KnowledgeDriftDetected',
  'GraphDriftDetected',
  'DiagnosisFoundKnowledgeDrift',
];

// Raw-text prefilter: a file naming none of these cannot clash or be the sentinel (readCode docs).
const EVENT_NEEDLES = [...Object.values(KNOWLEDGE_EVENT_NAMES), ...FOREIGN_FORBIDDEN];

async function collisions(
  root: string,
  own: readonly string[],
  needles: readonly string[] | undefined = EVENT_NEEDLES,
): Promise<{ files: string[]; literals: Set<string>; clashes: string[] }> {
  const files = walkRepo(root, ['apps', 'packages'], CODE_FILE).filter(
    (f) => f !== OWN_EVENTS_FILE,
  );
  const literals = new Set<string>();
  const clashes: string[] = [];
  for (const f of files) {
    const text = readCode(root, f, needles);
    for (const m of text.matchAll(/\bname:\s*['"]([A-Z][A-Za-z]+)['"]/g)) literals.add(m[1]!);
    for (const n of own) if (new RegExp(`['"\`]${n}['"\`]`).test(text)) clashes.push(`${f}: ${n}`);
  }
  return { files, literals, clashes };
}

describe('event names are unique to this producer (005 T014)', () => {
  const own = Object.values(KNOWLEDGE_EVENT_NAMES);

  it('the registry has no duplicates and none of the foreign names', () => {
    expect(new Set(own).size).toBe(own.length);
    for (const foreign of FOREIGN_FORBIDDEN) expect(own).not.toContain(foreign);
  });

  it('no other source in the repository declares an event with one of our names', async () => {
    const { files, literals, clashes } = await collisions(REPO_ROOT, own);
    expect(files.length).toBeGreaterThan(100);
    expect(literals.has('GraphDriftDetected')).toBe(true); // sentinel: the walk sees 004's events
    expect(clashes).toEqual([]);
  });

  it(
    'the prefilter does not change the result (real repo and regex-literal fixture)',
    { timeout: 60_000 },
    async () => {
      const fast = await collisions(REPO_ROOT, own);
      const full = await collisions(REPO_ROOT, own, undefined);
      expect(fast.files).toEqual(full.files);
      expect(fast.clashes).toEqual(full.clashes);
      expect(fast.literals.has('GraphDriftDetected')).toBe(true);
      const root = mkdtempSync(join(tmpdir(), 'event-names-pf-'));
      mkdirSync(join(root, 'apps'), { recursive: true });
      mkdirSync(join(root, 'packages/o/src'), { recursive: true });
      writeFileSync(
        join(root, 'packages/o/src/e.ts'),
        "export const t = (s: string) => s.replace(/\\/*$/, '');\nconst e = { name: 'ExpectationAdopted' };\n/** end */",
      );
      writeFileSync(join(root, 'packages/o/src/none.ts'), 'export const z = 1;');
      const a = await collisions(root, own);
      expect(a.clashes).toEqual(['packages/o/src/e.ts: ExpectationAdopted']);
      expect(a.clashes).toEqual((await collisions(root, own, undefined)).clashes);
    },
  );

  it('flags a duplicate literal planted in another file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'event-names-'));
    mkdirSync(join(root, 'apps'), { recursive: true });
    mkdirSync(join(root, 'packages/other/src'), { recursive: true });
    writeFileSync(
      join(root, 'packages/other/src/events.ts'),
      "export const e = { name: 'ExpectationAdopted' };",
    );
    expect((await collisions(root, own)).clashes).toEqual([
      'packages/other/src/events.ts: ExpectationAdopted',
    ]);
  });
});
