import { validateEgress } from '@healer/boundary-contract';
import type { CollectionGap, DiscoveryAdapter } from '../domain/discovery-adapter.js';
import type { DiscoveryItem, SourceResult } from '../domain/discovery-batch.js';
import type { DiscoveryLogger } from '../domain/discovery-logger.js';
import { deriveProvisionalSourceOutcome } from '../domain/source-outcome.js';

/**
 * Collection was cancelled mid-run (T021 "cancellable"): `runDiscovery` never calls
 * `ingestDiscoveryBatch` when this throws, so no draft is written and the run's `finished_at`
 * stays null — "run not marked complete" holds by construction, not by a check.
 */
export class DiscoveryAbortedError extends Error {
  constructor() {
    super('discovery run aborted');
    this.name = 'DiscoveryAbortedError';
  }
}

export interface DiscoverySourceRequest {
  readonly adapter: DiscoveryAdapter;
  /** `false` when the run's scope did not ask for this source — `not_attempted`, `collect()`
   *  never called (data-model.md: "there is no `skipped`"). */
  readonly requested: boolean;
}

export interface CollectDiscoveryOptions {
  readonly tenantId: string;
  readonly runnerId: string;
  readonly perSourceTimeoutMs: number;
  readonly itemCap: number;
  readonly signal?: AbortSignal;
  readonly logger?: DiscoveryLogger;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/**
 * Review fix: previously only `timeoutController.abort()` fired — `adapter.collect()` itself was
 * plain `await`ed with nothing racing it, so a non-cooperating adapter (one that does not check
 * `signal`) hung the whole `Promise.all` forever. This races the adapter call against the
 * orchestrator's own timeout rejection, the same technique as `@healer/workflow`'s
 * `runWithBudget` (not imported — that package pulls in BullMQ and job-state concerns this one
 * has nothing to do with; the race itself is three lines, not worth the coupling). The signal is
 * still passed to `adapter.collect()` as a courtesy: a cooperative adapter stops early and frees
 * real resources, but the *bound* no longer depends on it doing so — JS cannot force-preempt a
 * running promise, so a non-cooperating adapter's call keeps running abandoned in the background
 * (documented limitation, matches `runWithBudget`'s own doc comment).
 */
function raceAgainstTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  outerSignal: AbortSignal | undefined,
): { result: Promise<T>; timedOut: () => boolean; cleanup: () => void } {
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  outerSignal?.addEventListener('abort', onOuterAbort, { once: true });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const timeoutRejection = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      'abort',
      () =>
        reject(Object.assign(new Error('discovery source bound exceeded'), { name: 'AbortError' })),
      { once: true },
    );
  });

  return {
    result: Promise.race([work(controller.signal), timeoutRejection]),
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      outerSignal?.removeEventListener('abort', onOuterAbort);
    },
  };
}

async function collectOne(
  request: DiscoverySourceRequest,
  options: CollectDiscoveryOptions,
): Promise<SourceResult> {
  const { adapter } = request;
  if (!request.requested) {
    const outcome = deriveProvisionalSourceOutcome({ kind: 'not_requested' });
    return {
      sourceKey: adapter.key,
      adapterVersion: adapter.version,
      ...outcome,
      durationMs: 0,
      items: [],
      gaps: [],
    };
  }

  const race = raceAgainstTimeout(
    (signal) => adapter.collect({ tenantId: options.tenantId, runnerId: options.runnerId, signal }),
    options.perSourceTimeoutMs,
    options.signal,
  );
  const startedAt = Date.now();
  try {
    const facts = await race.result;
    const durationMs = Date.now() - startedAt;
    const allItems: readonly DiscoveryItem[] = [
      ...facts.componentCandidates,
      ...facts.deploymentUnitCandidates,
      ...facts.dependencyObservations,
      ...facts.repositoryRefs,
    ];
    // T021 "bounded": every item passes validateEgress (graph-contract.md §3 — a failing item is
    // never sent) before the item cap is applied. Review fix: a rejected item used to just vanish
    // from `validated` with nothing counting it — the source then read as `collected` even if
    // every single item failed validation. It is now counted and surfaced as a `collection_gap`
    // (never the item's own content — only the count and the adapter key cross into the gap).
    const egressRejected = allItems.filter((item) => !validateEgress(item).ok);
    const validated = allItems.filter((item) => validateEgress(item).ok);
    const truncated = validated.length > options.itemCap;
    const items = truncated ? validated.slice(0, options.itemCap) : validated;

    const syntheticGaps: CollectionGap[] = [];
    if (egressRejected.length > 0) {
      options.logger?.warn(
        {
          sourceKey: adapter.key,
          runnerId: options.runnerId,
          rejectedCount: egressRejected.length,
        },
        'discovery source emitted items that failed egress validation',
      );
      syntheticGaps.push({
        kind: 'collection_gap',
        what: adapter.key,
        why: `schema_rejected: ${egressRejected.length} item(s) failed egress validation`,
        withheldByRedaction: false,
      });
    }
    if (truncated) {
      syntheticGaps.push({
        kind: 'collection_gap',
        what: adapter.key,
        why: 'item cap reached',
        withheldByRedaction: false,
      });
    }
    const gaps = [...facts.collectionGaps, ...syntheticGaps];

    const outcome = deriveProvisionalSourceOutcome({
      kind: 'completed',
      items,
      gaps,
      truncated,
      egressRejectedCount: egressRejected.length,
    });
    return {
      sourceKey: adapter.key,
      adapterVersion: adapter.version,
      ...outcome,
      durationMs,
      items,
      gaps,
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const timedOut = race.timedOut();
    const outcome = deriveProvisionalSourceOutcome(
      timedOut ? { kind: 'timed_out' } : { kind: 'threw' },
    );
    // Review fix: a bare `catch {}` made a TypeError, an auth failure, a DNS failure and a
    // malformed reader response all indistinguishable. Logged here — never the payload, only the
    // error's class/message and whether it was an abort — the gap `why` stays a reason code, not
    // a quoted message (the closed-vocabulary reason codes are the contract, not free text).
    options.logger?.warn(
      {
        sourceKey: adapter.key,
        runnerId: options.runnerId,
        tenantId: options.tenantId,
        timedOut,
        aborted: isAbortError(err),
        errorClass: err instanceof Error ? err.name : typeof err,
        errorMessage: err instanceof Error ? err.message : String(err),
      },
      'discovery source collection failed',
    );
    return {
      sourceKey: adapter.key,
      adapterVersion: adapter.version,
      ...outcome,
      durationMs,
      items: [],
      gaps: [],
    };
  } finally {
    race.cleanup();
  }
}

/**
 * `RunDiscovery`'s collection half (T021, FR-022): every requested adapter runs in parallel
 * (`Promise.all`), read-only against every customer system (the `DiscoveryAdapter` port has no
 * write method — structural, proven by a type-level test, not by this function), bounded by a
 * per-source timeout (enforced by the orchestrator's own race, not adapter cooperation) and an
 * item cap, and cancellable by `options.signal`. A run-wide abort rejects the whole call rather
 * than resolving with a partial batch.
 */
export async function collectDiscovery(
  sources: readonly DiscoverySourceRequest[],
  options: CollectDiscoveryOptions,
): Promise<readonly SourceResult[]> {
  const collecting = Promise.all(sources.map((source) => collectOne(source, options)));
  if (options.signal === undefined) return collecting;
  if (options.signal.aborted) throw new DiscoveryAbortedError();
  const aborted = new Promise<never>((_, reject) => {
    options.signal!.addEventListener('abort', () => reject(new DiscoveryAbortedError()), {
      once: true,
    });
  });
  return Promise.race([collecting, aborted]);
}
