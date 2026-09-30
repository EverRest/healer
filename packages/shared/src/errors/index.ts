/**
 * One error format across every app (012 FR-011). A caller — dashboard, runner, MCP
 * client — must be able to branch on a code, so codes are a closed union rather than
 * prose, and the message never carries customer content.
 */
export const ERROR_CODES = [
  'VALIDATION',
  'NOT_FOUND',
  'CONFLICT',
  'PRECONDITION_FAILED',
  'UNAUTHENTICATED',
  'RATE_LIMITED',
  'BUDGET_EXHAUSTED',
  'DECISION_ALREADY_CONSUMED',
  'DECISION_NOT_ALLOWED',
  'DIGEST_MISMATCH',
  'STALE_AUTONOMY_EPOCH',
  'CEILING_EXCEEDED',
  'UNDO_NOT_ATTESTED',
  'STEP_ATTRIBUTION_MISMATCH',
  'EVIDENCE_REQUIRED',
  'UNREDACTED_FIELD',
  'PROTOCOL_UNSUPPORTED',
  'CAPABILITY_MISSING',
  'WALL_CLOCK_EXCEEDED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorBody {
  readonly code: ErrorCode;
  readonly message: string;
  /** Structured, caller-actionable detail. Never a log body, a payload or a source excerpt. */
  readonly details?: Readonly<Record<string, string | number | boolean | string[]>>;
  readonly correlationId?: string;
}

export class HealerError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: ErrorBody['details'],
  ) {
    super(message);
    this.name = 'HealerError';
  }

  toBody(correlationId?: string): ErrorBody {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
      ...(correlationId ? { correlationId } : {}),
    };
  }
}

const STATUS: Record<ErrorCode, number> = {
  VALIDATION: 422,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  UNAUTHENTICATED: 401,
  RATE_LIMITED: 429,
  BUDGET_EXHAUSTED: 429,
  DECISION_ALREADY_CONSUMED: 409,
  DECISION_NOT_ALLOWED: 409,
  DIGEST_MISMATCH: 409,
  STALE_AUTONOMY_EPOCH: 409,
  CEILING_EXCEEDED: 422,
  UNDO_NOT_ATTESTED: 422,
  STEP_ATTRIBUTION_MISMATCH: 422,
  EVIDENCE_REQUIRED: 422,
  UNREDACTED_FIELD: 422,
  PROTOCOL_UNSUPPORTED: 426,
  CAPABILITY_MISSING: 412,
  WALL_CLOCK_EXCEEDED: 500,
  INTERNAL: 500,
};

export function httpStatusFor(code: ErrorCode): number {
  return STATUS[code];
}

/**
 * An unexpected error becomes `INTERNAL` with a fixed message. The original is logged,
 * never returned: an exception message is the most common way a query, a path or a
 * secret reaches a client.
 */
export function toErrorBody(error: unknown, correlationId?: string): ErrorBody {
  if (error instanceof HealerError) return error.toBody(correlationId);
  return {
    code: 'INTERNAL',
    message: 'Internal error',
    ...(correlationId ? { correlationId } : {}),
  };
}
