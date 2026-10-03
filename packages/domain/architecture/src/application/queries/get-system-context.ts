import { scope, type TenantContext } from '@healer/shared';
import type { SystemContext, SystemContextRepository } from '../../domain/system-context.js';
import type { ReadEnvelope } from '../../domain/read-envelope.js';

/**
 * `GetSystemContext` (T049): the tenant comes from the auth context, never from a parameter, so
 * the repository only ever sees a `TenantScoped` filter. The query takes no argument that could
 * select a style or a shape.
 */
export function getSystemContext(
  repo: SystemContextRepository,
  context: TenantContext,
): Promise<ReadEnvelope<SystemContext>> {
  return repo.read(scope(context, {}));
}
