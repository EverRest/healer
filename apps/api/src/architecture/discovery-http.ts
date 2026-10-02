import { BadRequestException } from '@nestjs/common';
import type { GraphReviewActor } from '@healer/domain-architecture';
import { TenantContext, TenantIsolationError } from '@healer/shared';

/** Shared by every `/discovery/*` controller — same deliberate, TODO-flagged stub-auth pattern as
 *  `IssuesController.resolveTenant`/`policy-http.ts`'s `resolveTenant` (001 T019): no credential
 *  is verified yet. */
export function resolveTenant(tenantIdHeader: string | undefined): TenantContext {
  try {
    return TenantContext.forTrustedInternalUse(tenantIdHeader ?? '');
  } catch (error) {
    if (error instanceof TenantIsolationError) {
      throw new BadRequestException('X-Tenant-Id header is missing or not a valid tenant id');
    }
    throw error;
  }
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_ACTOR_LENGTH = 128;

/** `Idempotency-Key` — same convention as `policy-http.ts`'s `requireIdempotencyKey`: required
 *  and shape-validated, not stored (same known gap, QUESTIONS.md "001 T057"). */
export function requireIdempotencyKey(key: string | undefined): void {
  if (key === undefined || !UUID_PATTERN.test(key)) {
    throw new BadRequestException('Idempotency-Key header is required and must be a UUID');
  }
}

const GRAPH_REVIEW_ACTOR_TYPES: ReadonlySet<string> = new Set([
  'agent',
  'human',
  'system',
  'runner',
]);

/**
 * Where a caller's actor identity gets resolved from the request, for `confirmDraftItems`/
 * `rejectDraftItems` (FR-010). `confirmDraftItems`/`rejectDraftItems` themselves take a plain
 * `GraphReviewActor` — they do not parse one from any header; this is that translation, mirroring
 * the project's established `X-Tenant-Id` stub-auth convention rather than inventing a new one.
 *
 * `X-Actor-Type` (new, this batch) carries which of the four actor types is calling; `X-Actor-Id`
 * reuses the existing `X-Actor-Id` convention (`policy-http.ts`) for the actor's own reference;
 * `X-Agent-Run-Id` is required only when the actor type is `agent` — `GraphReviewActor`'s own
 * discriminated union (`graph-audit-entry.ts`) already makes "agent with no agentRunId"
 * unrepresentable one layer down (SC-007: every agent-caused entry, including a refused one,
 * must resolve to a real `agent_run`), so this is where that same requirement is enforced at the
 * HTTP boundary.
 *
 * **No credential or capability registry exists yet** (`capabilities.ts`'s own doc comment) — a
 * caller asserts its own actor type exactly as it asserts its own tenant id today. The real
 * guarantee this stands in for is `requireHumanReviewActor`'s structural refusal of every
 * non-human actor before any write, not this header's honesty; recorded in QUESTIONS.md,
 * consistent with every earlier Phase 3 sub-batch's note on the same gap.
 */
export function resolveGraphReviewActor(
  actorTypeHeader: string | undefined,
  actorIdHeader: string | undefined,
  agentRunIdHeader: string | undefined,
): GraphReviewActor {
  const actorType = actorTypeHeader?.trim() ?? '';
  if (!GRAPH_REVIEW_ACTOR_TYPES.has(actorType)) {
    throw new BadRequestException(
      'X-Actor-Type header is required and must be one of agent, human, system, runner',
    );
  }

  const actorRef = actorIdHeader?.trim() ?? '';
  if (actorRef === '' || actorRef.length > MAX_ACTOR_LENGTH) {
    throw new BadRequestException(
      `X-Actor-Id header is required (1-${MAX_ACTOR_LENGTH} characters)`,
    );
  }

  if (actorType === 'agent') {
    const agentRunId = agentRunIdHeader?.trim() ?? '';
    if (agentRunId === '' || !UUID_PATTERN.test(agentRunId)) {
      throw new BadRequestException(
        'X-Agent-Run-Id header is required and must be a UUID when X-Actor-Type is agent',
      );
    }
    return { actorType: 'agent', actorRef, agentRunId };
  }

  return { actorType: actorType as 'human' | 'system' | 'runner', actorRef };
}
