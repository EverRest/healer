import {
  directiveRefusal,
  type ControlPlaneDirective,
  type DirectiveRefusalReason,
} from '@healer/boundary-contract';
import { computePromptDigest } from '@healer/prompts';
import type { DirectiveHandler } from './directive-dispatcher.js';

/**
 * Runner-side inference gate (012 T093, FR-038, FR-039, FR-046a, C-35, ADR 0010).
 *
 * Every guarantee here is enforced by a refusal that stops `runAgent` from being reached: this
 * handler throws `DirectiveRefusedError` before the fetch (capability) or before the run (prompt
 * id, digest), and `dispatchDirectives` logs the throw and leaves the directive retryable. The
 * directive schema is strict, so a credential can never ride on a directive; the provider
 * credential is the injected `runAgent`'s business, resolved from the customer's secret manager.
 */
export type PromptVersion = Extract<ControlPlaneDirective, { kind: 'prompt_version' }>;
type AgentDirective = Extract<ControlPlaneDirective, { kind: 'agent_directive' }>;

export class DirectiveRefusedError extends Error {
  constructor(readonly reason: DirectiveRefusalReason) {
    super(`directive refused: ${reason}`);
    this.name = 'DirectiveRefusedError';
  }
}

export interface AgentDirectiveHandlerDeps {
  /** The capabilities this runner declared in its handshake. */
  readonly capabilities: readonly string[];
  /** Fetch a published prompt by version identifier — never by key (FR-038). */
  readonly fetchPrompt: (promptVersionId: string) => Promise<PromptVersion>;
  readonly runAgent: (directive: AgentDirective, prompt: PromptVersion) => Promise<void>;
  /** Every non-agent directive goes here unchanged. */
  readonly next: DirectiveHandler;
}

export function createAgentDirectiveHandler(deps: AgentDirectiveHandlerDeps): DirectiveHandler {
  return async (directive) => {
    if (directive.kind !== 'agent_directive') return deps.next(directive);

    const refusal = directiveRefusal(directive, deps.capabilities);
    if (refusal) throw new DirectiveRefusedError(refusal);

    const prompt = await deps.fetchPrompt(directive.promptVersionId);
    if (prompt.promptVersionId !== directive.promptVersionId) {
      throw new DirectiveRefusedError('prompt_id_mismatch');
    }
    // `prompt_version` carries no `schemaRef`, so the recompute is exact only for schemaRef-less
    // prompts; a prompt published with a schemaRef fails closed here until the shape grows one.
    if (
      prompt.digest !== directive.promptDigest ||
      computePromptDigest(prompt.body) !== prompt.digest
    ) {
      throw new DirectiveRefusedError('prompt_digest_mismatch');
    }
    await deps.runAgent(directive, prompt);
  };
}
