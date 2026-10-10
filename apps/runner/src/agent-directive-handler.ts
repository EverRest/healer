import {
  ControlPlaneDirective,
  DirectiveRefusalReason,
  directiveRefusal,
} from '@healer/boundary-contract';
import { computePromptDigest } from '@healer/prompts';
import type { DirectiveHandler } from './directive-dispatcher.js';

/**
 * Runner-side inference gate (012 T093, FR-038, FR-039, FR-046a, C-35, ADR 0010).
 *
 * Every guarantee here is enforced by a refusal that stops `runAgent` from being reached: this
 * handler refuses before the fetch (capability) or before the run (prompt shape, id, digest).
 * A refusal is deterministic, so it is terminal: logged as a structured field and returned
 * normally, which makes `dispatchDirectives` mark the directive seen instead of retrying forever.
 * Any other failure stays retryable but is rethrown with a fixed message, because the dispatcher
 * logs `err.message` and provider errors can embed bodies. The directive schema is strict, so a
 * credential can never ride on a directive; the provider credential is the injected `runAgent`'s
 * business, resolved from the customer's secret manager.
 */
type AgentDirective = Extract<ControlPlaneDirective, { kind: 'agent_directive' }>;
type PromptVersion = Extract<ControlPlaneDirective, { kind: 'prompt_version' }>;

/** What `fetchPrompt` is trusted to return — validated at runtime before use. */
export type FetchedPrompt = PromptVersion;

/** What `runAgent` receives: only the digest-covered fields. `parameters` are not covered by the
 *  digest, so they are unrepresentable here. */
export interface VerifiedPrompt {
  readonly promptVersionId: string;
  readonly body: string;
}

export class DirectiveRefusedError extends Error {
  readonly reason: DirectiveRefusalReason;
  constructor(reason: DirectiveRefusalReason) {
    const parsed = DirectiveRefusalReason.parse(reason);
    super(`directive refused: ${parsed}`);
    this.name = 'DirectiveRefusedError';
    this.reason = parsed;
  }
}

export class AgentDirectiveFailedError extends Error {
  constructor(readonly stage: 'prompt_fetch' | 'agent_run') {
    super(`agent directive failed at ${stage}`);
    this.name = 'AgentDirectiveFailedError';
  }
}

export interface AgentDirectiveHandlerDeps {
  /** The capabilities this runner declared in its handshake. */
  readonly capabilities: readonly string[];
  /** Fetch a published prompt by version identifier — never by key (FR-038). */
  readonly fetchPrompt: (promptVersionId: string) => Promise<FetchedPrompt>;
  readonly runAgent: (directive: AgentDirective, prompt: VerifiedPrompt) => Promise<void>;
  /** Every non-agent directive goes here unchanged. */
  readonly next: DirectiveHandler;
  readonly logger: { warn(obj: Record<string, unknown>, msg: string): void };
}

async function stage<T>(name: 'prompt_fetch' | 'agent_run', work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof DirectiveRefusedError) throw error;
    throw new AgentDirectiveFailedError(name);
  }
}

async function verifiedPrompt(
  directive: AgentDirective,
  fetchPrompt: AgentDirectiveHandlerDeps['fetchPrompt'],
): Promise<VerifiedPrompt> {
  const fetched = await stage('prompt_fetch', () => fetchPrompt(directive.promptVersionId));
  const parsed = ControlPlaneDirective.safeParse(fetched);
  if (!parsed.success || parsed.data.kind !== 'prompt_version' || /\p{Surrogate}/u.test(parsed.data.body)) {
    throw new DirectiveRefusedError('prompt_shape_invalid');
  }
  const prompt = parsed.data;
  if (prompt.promptVersionId !== directive.promptVersionId) {
    throw new DirectiveRefusedError('prompt_id_mismatch');
  }
  // `prompt_version` carries no `schemaRef`, so the recompute covers schemaRef-less prompts only;
  // see QUESTIONS.md "012 T093-T095" for the digest-construction caveats.
  if (
    prompt.digest !== directive.promptDigest ||
    computePromptDigest(prompt.body) !== prompt.digest
  ) {
    throw new DirectiveRefusedError('prompt_digest_mismatch');
  }
  return { promptVersionId: prompt.promptVersionId, body: prompt.body };
}

export function createAgentDirectiveHandler(deps: AgentDirectiveHandlerDeps): DirectiveHandler {
  return async (directive) => {
    if (directive.kind !== 'agent_directive') return deps.next(directive);
    try {
      const refusal = directiveRefusal(directive, deps.capabilities);
      if (refusal) throw new DirectiveRefusedError(refusal);
      const prompt = await verifiedPrompt(directive, deps.fetchPrompt);
      await stage('agent_run', () => deps.runAgent(directive, prompt));
    } catch (error) {
      if (!(error instanceof DirectiveRefusedError)) throw error;
      deps.logger.warn(
        {
          refusalReason: error.reason,
          directiveKind: directive.kind,
          promptVersionId: directive.promptVersionId,
        },
        'agent directive refused — terminal, marked seen',
      );
    }
  };
}
