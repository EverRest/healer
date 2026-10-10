import type { ControlPlaneDirective } from './shapes.js';

/**
 * Runner-side inference (012 T093, FR-046a, C-35, ADR 0010): a model call runs where its inputs
 * live, so a runner that cannot run one must say so, and the control plane must not hand it an
 * `agent_directive`. `INFERENCE_CAPABILITY` is the one authority for the capability's name — no
 * second literal anywhere.
 */
export const INFERENCE_CAPABILITY = 'inference';

/** The closed list of reasons a directive is refused before any work starts. One authority. */
export const DIRECTIVE_REFUSAL_REASONS = [
  'inference_capability_missing',
  'prompt_id_mismatch',
  'prompt_digest_mismatch',
] as const;

export type DirectiveRefusalReason = (typeof DIRECTIVE_REFUSAL_REASONS)[number];

/**
 * Capability gate for a directive. The reader that refuses to proceed is the runner's
 * agent-directive handler (`apps/runner`), which throws on a defined result before any prompt
 * fetch or agent run; a control-plane producer calls the same function before emitting.
 * Capability presence is a structural fact, never a model-confidence judgement.
 */
export function directiveRefusal(
  directive: ControlPlaneDirective,
  declaredCapabilities: readonly string[],
): DirectiveRefusalReason | undefined {
  if (directive.kind === 'agent_directive' && !declaredCapabilities.includes(INFERENCE_CAPABILITY)) {
    return 'inference_capability_missing';
  }
  return undefined;
}
