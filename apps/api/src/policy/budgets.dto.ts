import { z } from 'zod';

/** `PUT /budgets` body (T067, contracts/openapi.yaml). Only the shape is validated here — the
 *  product bounds (FR-021) and the scope/period pairing are `putBudgetLimit`'s own refusal, and
 *  the migration's CHECKs after that; they are never restated as a third copy at the HTTP edge. */
export const putBudgetRequestSchema = z
  .object({
    scopeType: z.enum(['issue', 'tenant']),
    period: z.enum(['issue', 'day', 'month']),
    spendLimit: z.number().finite().optional(),
    timeLimitMs: z.number().int().optional(),
    softThresholdPcts: z.array(z.number().int()).max(16).optional(),
    escalationAttemptCap: z.number().int().optional(),
  })
  .strict();

/** `GET /budgets/state` query. The tenant is never a parameter — it is the authenticated one. */
export const budgetStateQuerySchema = z
  .object({
    scopeType: z.enum(['issue', 'tenant']),
    scopeId: z.string().uuid().optional(),
    period: z.enum(['day', 'month']).optional(),
    workflowRunId: z.string().uuid().optional(),
  })
  .strict();
