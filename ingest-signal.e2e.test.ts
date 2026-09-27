import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import {
  ingestSignal,
  PrismaIssueRepository,
  PrismaNormalisationRulesetRepository,
  type Signal,
} from '@healer/domain-issues';
import { TenantContext, newCorrelationId, scope, withCorrelation } from '@healer/shared';
import { applySqlFile, query, startPostgres, type StartedPostgres } from './test/containers.js';

/**
 * `ingestSignal` (001 T018, FR-002): compute the fingerprint and attach a matching signal to the
 * same *open* issue, or create one when nothing open matches — the orchestration T016/T017's pure
 * fingerprinting and T012's repository compose into.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('./prisma/migrations/', import.meta.url));

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const TENANT_ID = '00000000-0000-0000-8000-0000000000f1';
const CONTEXT = TenantContext.forTrustedInternalUse(TENANT_ID);

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    observedAt: new Date('2026-01-01T00:00:00Z'),
    component: 'checkout-service',
    environment: 'prod',
    errorSignature: { exceptionType: 'NullPointerException', errorCode: 'E500' },
    ...overrides,
  };
}

describe('ingestSignal (001 T018, FR-002)', () => {
  let pg: StartedPostgres;
  let prisma: PrismaClient;
  let issueRepo: PrismaIssueRepository;
  let rulesetRepo: PrismaNormalisationRulesetRepository;

  beforeAll(async () => {
    pg = await startPostgres();
    for (const name of migrationNames()) {
      await applySqlFile(pg, `${MIGRATIONS_DIR}${name}/migration.sql`);
    }
    prisma = new PrismaClient({ datasourceUrl: pg.url });
    issueRepo = new PrismaIssueRepository(prisma);
    rulesetRepo = new PrismaNormalisationRulesetRepository(prisma);
    await rulesetRepo.publish({ rules: { stripPatterns: ['[0-9a-f]{8}-[0-9a-f-]{27}'] } });
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg?.stop();
  });

  it('a signal with no match creates a new issue, occurrenceCount 1', () =>
    withCorrelation(newCorrelationId(), async () => {
      const result = await ingestSignal(
        rulesetRepo,
        issueRepo,
        CONTEXT,
        signal({ errorSignature: { exceptionType: 'NoMatchCase' } }),
      );
      expect(result.created).toBe(true);
      expect(result.issue).toMatchObject({
        state: 'detected',
        kind: 'monitoring_alert',
        occurrenceCount: 1n,
      });
    }));

  it('a second signal sharing the fingerprint attaches to the same open issue', () =>
    withCorrelation(newCorrelationId(), async () => {
      const sharedSignature = signal({
        errorSignature: { exceptionType: 'SharedFingerprintCase' },
      });
      const first = await ingestSignal(rulesetRepo, issueRepo, CONTEXT, sharedSignature);
      const second = await ingestSignal(
        rulesetRepo,
        issueRepo,
        CONTEXT,
        signal({
          errorSignature: { exceptionType: 'SharedFingerprintCase' },
          observedAt: new Date('2026-01-02T00:00:00Z'),
        }),
      );
      expect(second.created).toBe(false);
      expect(second.issue.id).toBe(first.issue.id);
      expect(second.issue.occurrenceCount).toBe(2n);
      expect(second.issue.lastSeenAt).toEqual(new Date('2026-01-02T00:00:00Z'));
    }));

  it('replaying 200 signals sharing a signature collapses to one issue with the right count (SC-001)', () =>
    withCorrelation(newCorrelationId(), async () => {
      const burstSignature = signal({ errorSignature: { exceptionType: 'BurstError' } });
      let last = await ingestSignal(rulesetRepo, issueRepo, CONTEXT, burstSignature);
      for (let i = 1; i < 200; i++) {
        last = await ingestSignal(
          rulesetRepo,
          issueRepo,
          CONTEXT,
          signal({
            errorSignature: { exceptionType: 'BurstError' },
            observedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
          }),
        );
      }
      expect(last.issue.occurrenceCount).toBe(200n);
      expect(last.issue.firstSeenAt).toEqual(new Date('2026-01-01T00:00:00Z'));
      expect(last.issue.lastSeenAt).toEqual(new Date(Date.UTC(2026, 0, 1, 0, 0, 199)));
      // 12 000 is SC-001's own number; a load characteristic verified by 001 T026's load check,
      // not re-replayed literally here — this proves the arithmetic, not the throughput.
    }));

  it('a genuinely different exception type creates a separate issue on the same component', () =>
    withCorrelation(newCorrelationId(), async () => {
      const a = await ingestSignal(
        rulesetRepo,
        issueRepo,
        CONTEXT,
        signal({ errorSignature: { exceptionType: 'DistinctErrorA' } }),
      );
      const b = await ingestSignal(
        rulesetRepo,
        issueRepo,
        CONTEXT,
        signal({ errorSignature: { exceptionType: 'DistinctErrorB' } }),
      );
      expect(a.issue.id).not.toBe(b.issue.id);
    }));

  it('a signal matching only a resolved issue creates a new one — T022 owns reopen/recurrence', () =>
    withCorrelation(newCorrelationId(), async () => {
      const resolvedSignature = signal({ errorSignature: { exceptionType: 'ResolvedCase' } });
      const first = await ingestSignal(rulesetRepo, issueRepo, CONTEXT, resolvedSignature);
      // Drive it to resolved directly against the repository, not through ingestSignal.
      await issueRepo.transition(
        scope(CONTEXT, { id: first.issue.id }),
        'investigating',
        'agent',
        'x',
      );
      await issueRepo.transition(
        scope(CONTEXT, { id: first.issue.id }),
        'resolved',
        'human',
        'pavlo',
      );

      const second = await ingestSignal(rulesetRepo, issueRepo, CONTEXT, resolvedSignature);
      expect(second.created).toBe(true);
      expect(second.issue.id).not.toBe(first.issue.id);

      const fingerprints = await query(
        pg,
        `select count(*) from "issue"."issue" where fingerprint = '${first.issue.fingerprint}'`,
      );
      expect(fingerprints).toBe('2');
    }));
});
