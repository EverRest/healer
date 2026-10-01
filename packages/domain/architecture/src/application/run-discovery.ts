import type { TenantContext } from '@healer/shared';
import type { AdapterConstants } from '../domain/discovery-batch.js';
import type { DiscoveryRepository, IngestedDraft } from '../domain/discovery-repository.js';
import {
  collectDiscovery,
  type CollectDiscoveryOptions,
  type DiscoverySourceRequest,
} from './collect-discovery.js';
import { ingestDiscoveryBatch } from './ingest-discovery-batch.js';
import { startDiscoveryRun, type StartDiscoveryRunInput } from './start-discovery-run.js';

export interface RunDiscoveryInput {
  readonly trigger: StartDiscoveryRunInput['trigger'];
  readonly runnerId: string;
  readonly sources: readonly DiscoverySourceRequest[];
  readonly perSourceTimeoutMs: number;
  readonly itemCap: number;
  readonly signal?: AbortSignal;
  readonly now?: Date;
}

/**
 * `startDiscoveryRun` → `collectDiscovery` → `ingestDiscoveryBatch`, composed in-process (plan
 * "Architecture of a run" — "what tests and a future runner wiring call"; dispatching to a real
 * runner is 012-runner's territory, not built here). The adapter constants `ingestDiscoveryBatch`
 * cross-checks against are built from the same `sources` list `collectDiscovery` ran, so a test
 * never has to keep two adapter lists in sync.
 */
export async function runDiscovery(
  repo: DiscoveryRepository,
  context: TenantContext,
  input: RunDiscoveryInput,
): Promise<IngestedDraft | null> {
  const run = await startDiscoveryRun(repo, context, {
    trigger: input.trigger,
    runnerId: input.runnerId,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });

  const collectOptions: CollectDiscoveryOptions = {
    tenantId: context.tenantId,
    runnerId: input.runnerId,
    perSourceTimeoutMs: input.perSourceTimeoutMs,
    itemCap: input.itemCap,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  };
  const sourceResults = await collectDiscovery(input.sources, collectOptions);

  const adapterConstants: Record<string, AdapterConstants> = {};
  for (const { adapter } of input.sources) {
    adapterConstants[adapter.key] = {
      version: adapter.version,
      layer: adapter.layer,
      provenance: adapter.provenance,
    };
  }

  return ingestDiscoveryBatch(repo, context, {
    runId: run.id,
    baseVersion: run.baseVersion,
    sources: sourceResults,
    adapterConstants,
  });
}
