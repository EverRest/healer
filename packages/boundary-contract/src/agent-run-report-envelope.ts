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
 * enum (the authority — schema.prisma) and `agent-run-report-writer.test.ts` fails if they drift;
 * `AGENT_RUN_OUTCOMES` and `AGENT_TOOL_CALL_OUTCOMES` are authoritative here, the column being text.
 */
export const AGENT_RUN_PROVIDERS = ['anthropic', 'openai', 'bedrock', 'vertex'] as const;

/** The smallest list the report's "outcome enumeration" (runner-protocol.md) needs; a verdict such
 *  as REJECT_PATCH is the verifier's *result*, not how its run ended. 012 QUESTIONS.md T093-T095. */
export const AGENT_RUN_OUTCOMES = ['completed', 'failed', 'stopped'] as const;
export const AGENT_TOOL_CALL_OUTCOMES = ['ok', 'error', 'denied'] as const;

const MAX_INT4 = 2_147_483_647;
/** `agent_run.cost` is numeric(12,6): 6 integer digits. A run beyond this is a defect to refuse. */
export const MAX_REPORTED_COST = 999_999;
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/);
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
