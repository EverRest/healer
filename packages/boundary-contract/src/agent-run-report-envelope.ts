import { z } from 'zod';
import { agentRunReport } from './shapes.js';

/**
 * What a runner sends so the control plane can write an `agent_run` (012 T094, FR-033, FR-046a,
 * ADR 0010). `agentRunReport` (shapes.ts) is the evidence shape and stays as it was for every
 * other consumer; this envelope is the stricter shape the *writer* needs: the report plus the
 * correlation, start time and idempotency key an `agent_run` row has and the report does not.
 *
 * Every field that reaches a table support reads is a uuid, a number, a closed list or a pattern —
 * never free text (`.strict()` everywhere): a model id, tool name or outcome is exactly where a
 * prompt fragment or an error body would otherwise ride in. The mechanism that refuses a
 * violating report is `AgentRunReportEnvelope.safeParse`, called by the ingress controller before
 * anything is dispatched.
 *
 * Closed lists, one authority each: `AGENT_RUN_PROVIDERS` restates the database's `provider_name`
 * enum (the authority — schema.prisma) and `apps/api/src/runners/agent-run-closed-lists.test.ts` fails if they drift;
 * `AGENT_RUN_OUTCOMES` and `AGENT_TOOL_CALL_OUTCOMES` are authoritative here, the column being text.
 */
export const AGENT_RUN_PROVIDERS = ['anthropic', 'openai', 'bedrock', 'vertex'] as const;

/** The smallest list the report's "outcome enumeration" (runner-protocol.md) needs; a verdict such
 *  as REJECT_PATCH is the verifier's *result*, not how its run ended. 012 QUESTIONS.md T093-T095. */
export const AGENT_RUN_OUTCOMES = ['completed', 'failed', 'stopped'] as const;
export const AGENT_TOOL_CALL_OUTCOMES = ['ok', 'error', 'denied'] as const;

const MAX_INT4 = 2_147_483_647;
/** The largest value `agent_run.cost` numeric(12,6) holds — the column is the authority and
 *  `toCostDecimal` (domain-policy) restates it; the closed-lists test pins the two together. A value
 *  that rounds past it at six decimals is refused by `toCostDecimal`, not here. */
export const MAX_REPORTED_COST = 999_999.999999;
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

// `_` is in the set on purpose: `read_file`, `mcp__x__y` are ordinary tool names, and a 400 here
// drops the whole report — and its spend.
const identifier = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.:/@-]{0,199}$/);
const uuid = z.string().uuid();

const strictReport = agentRunReport.extend({
  modelId: identifier,
  provider: z.enum(AGENT_RUN_PROVIDERS),
  promptVersionId: uuid,
  inputTokens: z.number().int().nonnegative().max(MAX_INT4),
  outputTokens: z.number().int().nonnegative().max(MAX_INT4),
  cost: z.number().finite().nonnegative().max(MAX_REPORTED_COST),
  toolCalls: z.array(
    z
      .object({
        name: identifier,
        argumentDigest: z.string().regex(/^[0-9a-f]{64}$/),
        outcome: z.enum(AGENT_TOOL_CALL_OUTCOMES),
      })
      .strict(),
  ),
  // Validated so a free-text field cannot ride in, but NOT stored: `agent_run` has no column for
  // it and nothing reads it yet (012 QUESTIONS.md T093-T095).
  decisionPathStepIds: z.array(identifier),
  outcome: z.enum(AGENT_RUN_OUTCOMES),
  durationMs: z.number().finite().nonnegative().max(MAX_DURATION_MS),
});

export const AgentRunReportEnvelope = z
  .object({
    /** The runner's idempotency key for this report: a redelivery carries the same id. */
    reportId: uuid,
    report: strictReport,
    correlationId: uuid,
    issueId: uuid.optional(),
    policyDecisionId: uuid.optional(),
    startedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type AgentRunReportEnvelope = z.infer<typeof AgentRunReportEnvelope>;
