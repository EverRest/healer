import { validateEgress } from '@healer/boundary-contract';
import type { DiscoveryAdapter } from '../domain/discovery-adapter.js';
import type { DiscoveryItem, SourceResult } from '../domain/discovery-batch.js';
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

  const timeoutController = new AbortController();
  const onOuterAbort = () => timeoutController.abort();
  options.signal?.addEventListener('abort', onOuterAbort, { once: true });
  const timer = setTimeout(() => timeoutController.abort(), options.perSourceTimeoutMs);
  const startedAt = Date.now();
  try {
    const facts = await adapter.collect({
      tenantId: options.tenantId,
      runnerId: options.runnerId,
      signal: timeoutController.signal,
    });
    const durationMs = Date.now() - startedAt;
    const allItems: readonly DiscoveryItem[] = [
      ...facts.componentCandidates,
      ...facts.deploymentUnitCandidates,
      ...facts.dependencyObservations,
      ...facts.repositoryRefs,
    ];
    // T021 "bounded": every item passes validateEgress (graph-contract.md §3 — a failing item is
    // never sent) before the item cap is applied. T030: dropping a failing item here is silent
    // unless the outcome says so too (plan "a failing item is not sent (status partial,
    // schema_rejected)") — `anyEgressRejected` is what makes that outcome, not only the drop,
    // observable.
    const validated = allItems.filter((item) => validateEgress(item).ok);
    const anyEgressRejected = validated.length !== allItems.length;
    const truncated = validated.length > options.itemCap;
    const items = truncated ? validated.slice(0, options.itemCap) : validated;
    const outcome = deriveProvisionalSourceOutcome({
      kind: 'completed',
      items,
      gaps: facts.collectionGaps,
      truncated,
      anyEgressRejected,
    });
    return {
      sourceKey: adapter.key,
      adapterVersion: adapter.version,
      ...outcome,
      durationMs,
      items,
      gaps: facts.collectionGaps,
    };
  } catch {
    const durationMs = Date.now() - startedAt;
    const outcome = deriveProvisionalSourceOutcome(
      timeoutController.signal.aborted && !options.signal?.aborted
        ? { kind: 'timed_out' }
        : { kind: 'threw' },
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
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * `RunDiscovery`'s collection half (T021, FR-022): every requested adapter runs in parallel
 * (`Promise.all`), read-only against every customer system (the `DiscoveryAdapter` port has no
 * write method — structural, proven by a type-level test, not by this function), bounded by a
 * per-source timeout and an item cap, and cancellable by `options.signal`. A run-wide abort
 * rejects the whole call rather than resolving with a partial batch.
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
