import { z } from 'zod';
import type { ControlPlaneDirective } from './shapes.js';

/**
 * Runner-side inference (012 T093, FR-046a, C-35, ADR 0010): a model call runs where its inputs
 * live, so a runner that cannot run one must say so, and an `agent_directive` must not run on it.
 * `INFERENCE_CAPABILITY` is the one authority for the capability's name; the match is exact.
 */
export const INFERENCE_CAPABILITY = 'inference';

/** The closed list of reasons a directive is refused. One authority; parsed at runtime by
 *  `DirectiveRefusedError`, so a reason outside it cannot be thrown or logged. */
export const DirectiveRefusalReason = z.enum([
  'inference_capability_missing',
  'prompt_id_mismatch',
  'prompt_digest_mismatch',
  'prompt_shape_invalid',
  'agent_runner_unavailable',
]);

export type DirectiveRefusalReason = z.infer<typeof DirectiveRefusalReason>;

/**
 * Capability gate for a directive. The reader that refuses to proceed is the runner's
 * agent-directive handler (`apps/runner`), which refuses before any prompt fetch or agent run.
 * It reads the runner's own DECLARATION (`RUNNER_CAPABILITIES`), not the control plane's resolved
 * set: that set is empty today because the control plane registers no requirements. No
 * control-plane producer exists yet; when one does, this function is the authority it must call
 * before emitting. Capability presence is a structural fact, never a model-confidence judgement.
 */
export function directiveRefusal(
  directive: ControlPlaneDirective,
  declaredCapabilities: readonly string[],
): DirectiveRefusalReason | undefined {
  if (
    directive.kind === 'agent_directive' &&
    !declaredCapabilities.includes(INFERENCE_CAPABILITY)
  ) {
    return 'inference_capability_missing';
  }
  return undefined;
}
