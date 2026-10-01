import { randomUUID } from 'node:crypto';
import { scope, type TenantContext } from '@healer/shared';
import type { DiscoveryRepository, DiscoveryRun } from '../domain/discovery-repository.js';

export interface StartDiscoveryRunInput {
  readonly trigger: 'onboarding' | 'scheduled' | 'manual' | 'post_deploy';
  readonly runnerId: string;
  readonly now?: Date;
}

/**
 * Creates the `discovery_run` row (plan "Architecture of a run"): `base_version` is the tenant's
 * current graph version (0 for a never-discovered tenant), read once here so every later step —
 * collection, the diff builder, the draft — works from the same pinned base rather than each
 * re-reading a version that could move mid-run.
 */
export async function startDiscoveryRun(
  repo: DiscoveryRepository,
  context: TenantContext,
  input: StartDiscoveryRunInput,
): Promise<DiscoveryRun> {
  return repo.createRun(
    scope(context, {
      id: randomUUID(),
      trigger: input.trigger,
      runnerId: input.runnerId,
      startedAt: input.now ?? new Date(),
    }),
  );
}
