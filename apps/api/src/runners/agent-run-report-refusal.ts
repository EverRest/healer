import {
  AgentRunReferenceNotFoundError,
  AgentRunReportConflictError,
  EvaluationInstantError,
} from '@healer/domain-policy';
import { HealerError, NotFoundError } from '@healer/shared';

export const REFUSAL_REASONS = [
  'runner_not_found',
  'report_conflict',
  'reference_not_found',
  'instant_skew',
  'validation',
] as const;

/**
 * The errors a runner can fix by sending a different report, as an HTTP status and a closed reason
 * code for the log (never a payload field). Anything else — including a `HealerError` with a code
 * that is not `VALIDATION` — is `null`: the caller rethrows it as the server fault it is, so a
 * defect never masquerades as a 422 the runner would retry forever.
 */
export function refusalFor(
  error: unknown,
): { status: 404 | 409 | 422; reason: (typeof REFUSAL_REASONS)[number]; message: string } | null {
  if (error instanceof NotFoundError) {
    return { status: 404, reason: 'runner_not_found', message: error.message };
  }
  if (error instanceof AgentRunReportConflictError) {
    return { status: 409, reason: 'report_conflict', message: error.message };
  }
  if (error instanceof AgentRunReferenceNotFoundError) {
    return { status: 422, reason: 'reference_not_found', message: error.message };
  }
  if (error instanceof EvaluationInstantError) {
    return { status: 422, reason: 'instant_skew', message: error.message };
  }
  if (error instanceof HealerError && error.code === 'VALIDATION') {
    return { status: 422, reason: 'validation', message: error.message };
  }
  return null;
}
