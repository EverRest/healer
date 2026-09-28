import { z } from 'zod';

/** Upper bound on a close reason. It lands in an append-only `issue_event.payload`, so it is
 *  bounded like every other free-text field this feature stores (R-05); a placeholder, not a
 *  product decision. */
export const MAX_CLOSE_REASON_LENGTH = 1000;

/** `POST /issues/{issueId}/close` body (`contracts/openapi.yaml`): a reason is required — a
 *  close with no "why" is the audit gap FR-021 exists to avoid. A NUL is refused because
 *  Postgres `jsonb` cannot store one (it would surface as a 500 instead of a 400). */
export const closeIssueRequestSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1)
    .max(MAX_CLOSE_REASON_LENGTH)
    .refine((reason) => !reason.includes('\u0000'), 'must not contain NUL'),
});
