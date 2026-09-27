import { TenantContext, withCorrelation } from '@healer/shared';
import type { SignalJobData } from '../../infrastructure/bullmq-signal-queue.js';
import { ingestSignal, type IngestSignalResult } from '../../domain/ingest-signal.js';
import type { IssueRepository } from '../../domain/repository.js';
import type { NormalisationRulesetRepository } from '../../domain/normalisation-ruleset.js';
import type { Signal } from '../../domain/signal.js';

/**
 * The consumer `BullmqSignalQueue`'s own comment named as not yet existing (001 T025): turns a
 * queued job's JSON-serialized shape back into what `ingestSignal` (001 T018) actually needs — a
 * real `TenantContext`, a real `Signal` (`observedAt` back to a `Date`, not the ISO string BullMQ
 * round-trips it as) — and runs it inside the *job's own* correlation id, the one
 * `BullmqSignalQueue` stamped at enqueue time, so a signal's whole life traces back to the
 * request that accepted it (FR-032), not a fresh id minted at processing time.
 *
 * Throws on any failure, deliberately: BullMQ's own retry (`QUEUE_CLASSES.ingestion`, 5 attempts,
 * exponential backoff) and dead-letter retention (`removeOnFail: false`) are what FR-019's
 * "retained for retry, repeated failure observable" already means at the queue layer — this
 * function has no retry logic of its own to duplicate that.
 */
export async function processSignalJob(
  rulesetRepo: NormalisationRulesetRepository,
  issueRepo: IssueRepository,
  data: SignalJobData,
): Promise<IngestSignalResult> {
  const context = TenantContext.forTrustedInternalUse(data.tenantId);
  const signal: Signal = { ...data.signal, observedAt: new Date(data.signal.observedAt) };
  return withCorrelation(data.correlationId, () =>
    ingestSignal(rulesetRepo, issueRepo, context, signal),
  );
}
