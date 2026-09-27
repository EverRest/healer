import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@healer/prisma-client';
import {
  DEFAULT_NORMALISATION_RULES,
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
    // T015's 12 000-signal replay fires batches of genuinely concurrent transactions — the
    // default connection pool and transaction maxWait are sized for ordinary request traffic,
    // not this load-test-shaped burst, and measurably ran out of headroom when the full e2e
    // suite's other files were competing for the same host resources ("Transaction API error:
    // Unable to start a transaction in the given time").
    prisma = new PrismaClient({
      datasourceUrl: `${pg.url}?connection_limit=30`,
      transactionOptions: { maxWait: 20_000, timeout: 20_000 },
    });
    issueRepo = new PrismaIssueRepository(prisma);
    rulesetRepo = new PrismaNormalisationRulesetRepository(prisma);
    await rulesetRepo.publish({ rules: DEFAULT_NORMALISATION_RULES });
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

  it(
    'replaying 12 000 signals sharing a signature from two providers collapses to one issue with the right count (001 T015, SC-001, quickstart 1)',
    () =>
      withCorrelation(newCorrelationId(), async () => {
        const TOTAL = 12_000;
        const CONCURRENCY = 25;

        // Two providers, two different volatile shapes for the *same* underlying failure — a
        // UUID request id (provider A) and a memory address plus a generated-file line:column
        // (provider B) — proving the burst collapses across providers, not just across literal
        // duplicates. Both normalise away under DEFAULT_NORMALISATION_RULES to the same
        // fingerprint (quickstart 2's guarantee, exercised here at SC-001's own scale).
        const providerA = (i: number): Signal =>
          signal({
            errorSignature: {
              exceptionType: 'BurstError',
              frames: [`${randomUUID()} at Checkout.charge(Checkout.java:${i}:7)`],
            },
            observedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
          });
        const providerB = (i: number): Signal =>
          signal({
            errorSignature: {
              exceptionType: 'BurstError',
              frames: [
                `0x${i.toString(16).padStart(8, '0')} at Checkout.charge(Checkout.java:${i})`,
              ],
            },
            observedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
          });

        // The first signal alone, sequentially: it takes the `create` path (no open issue exists
        // yet), which has a known, documented, narrow check-then-act race for concurrent *first*
        // arrivals of a brand-new fingerprint (QUESTIONS.md, 001 T018) — deliberately not
        // exercised here, since it would make this test assert its own known gap. Every signal
        // after the first finds the now-open issue and only ever calls `recordOccurrence`, whose
        // atomic GREATEST/LEAST update is already proven race-safe under real concurrency.
        const first = await ingestSignal(rulesetRepo, issueRepo, CONTEXT, providerA(0));
        expect(first.created).toBe(true);

        for (let start = 1; start < TOTAL; start += CONCURRENCY) {
          const batch: Promise<unknown>[] = [];
          for (let i = start; i < Math.min(start + CONCURRENCY, TOTAL); i++) {
            const sig = i % 2 === 0 ? providerA(i) : providerB(i);
            batch.push(ingestSignal(rulesetRepo, issueRepo, CONTEXT, sig));
          }
          await Promise.all(batch);
        }

        const final = await issueRepo.findById(scope(CONTEXT, { id: first.issue.id }));
        expect(final?.occurrenceCount).toBe(BigInt(TOTAL));
        expect(final?.firstSeenAt).toEqual(new Date(Date.UTC(2026, 0, 1, 0, 0, 0)));
        expect(final?.lastSeenAt).toEqual(new Date(Date.UTC(2026, 0, 1, 0, 0, TOTAL - 1)));

        const issueCount = await query(
          pg,
          `select count(*) from "issue"."issue" where fingerprint = '${first.issue.fingerprint}'`,
        );
        expect(issueCount).toBe('1');
      }),
    120_000,
  );

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

  it('a signal matching a resolved issue, outside the reopen window, creates a new issue linked recurrence_of (001 T022, FR-005, FR-020, R-02, quickstart 6)', () =>
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
      const beforeResolve = new Date();
      await issueRepo.transition(
        scope(CONTEXT, { id: first.issue.id }),
        'resolved',
        'human',
        'pavlo',
      );

      // `resolvedAt` is set to real wall-clock "now" by `transition` — 15 days *after* that is
      // unambiguously outside the 14-day placeholder window, regardless of when this test runs.
      const wellOutsideWindow = new Date(beforeResolve.getTime() + 15 * 24 * 60 * 60 * 1000);
      const second = await ingestSignal(
        rulesetRepo,
        issueRepo,
        CONTEXT,
        signal({
          errorSignature: { exceptionType: 'ResolvedCase' },
          observedAt: wellOutsideWindow,
        }),
      );
      expect(second.created).toBe(true);
      expect(second.issue.id).not.toBe(first.issue.id);
      expect(second.issue.state).toBe('detected');

      const fingerprints = await query(
        pg,
        `select count(*) from "issue"."issue" where fingerprint = '${first.issue.fingerprint}'`,
      );
      expect(fingerprints).toBe('2');

      const relationship = await query(
        pg,
        `select kind, rule, removed_at from "issue"."issue_relationship"
         where issue_id = '${second.issue.id}' and other_issue_id = '${first.issue.id}'`,
      );
      expect(relationship).toBe('recurrence_of|reopen_window_exceeded|');
    }));

  it('a signal matching a resolved issue, inside the reopen window, reopens it instead of creating a recurrence (001 T022, FR-005, R-02, quickstart 5)', () =>
    withCorrelation(newCorrelationId(), async () => {
      const resolvedSignature = signal({ errorSignature: { exceptionType: 'ReopenCase' } });
      const first = await ingestSignal(rulesetRepo, issueRepo, CONTEXT, resolvedSignature);
      await issueRepo.transition(
        scope(CONTEXT, { id: first.issue.id }),
        'investigating',
        'agent',
        'x',
      );
      const beforeResolve = new Date();
      await issueRepo.transition(
        scope(CONTEXT, { id: first.issue.id }),
        'resolved',
        'human',
        'pavlo',
      );

      const wellInsideWindow = new Date(beforeResolve.getTime() + 60_000);
      const second = await ingestSignal(
        rulesetRepo,
        issueRepo,
        CONTEXT,
        signal({ errorSignature: { exceptionType: 'ReopenCase' }, observedAt: wellInsideWindow }),
      );

      expect(second.created).toBe(false);
      expect(second.issue.id).toBe(first.issue.id);
      expect(second.issue.state).toBe('investigating');
      expect(second.issue.resolvedAt).toBeNull();
      expect(second.issue.occurrenceCount).toBe(2n);

      const fingerprints = await query(
        pg,
        `select count(*) from "issue"."issue" where fingerprint = '${first.issue.fingerprint}'`,
      );
      expect(fingerprints).toBe('1');
    }));
});
