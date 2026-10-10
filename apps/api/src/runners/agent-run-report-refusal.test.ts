import { describe, expect, it } from 'vitest';
import {
  AgentRunReferenceNotFoundError,
  AgentRunReportConflictError,
  EvaluationInstantError,
} from '@healer/domain-policy';
import { HealerError, NotFoundError } from '@healer/shared';
import { refusalFor } from './agent-run-report-refusal.js';

describe('refusalFor — which errors are the runner’s to fix (012 T094)', () => {
  it.each([
    [new NotFoundError('runner'), 404, 'runner_not_found'],
    [new AgentRunReportConflictError(), 409, 'report_conflict'],
    [new AgentRunReferenceNotFoundError('policy_decision'), 422, 'reference_not_found'],
    [new EvaluationInstantError(900_000, 300_000), 422, 'instant_skew'],
    [new HealerError('VALIDATION', 'bad cost'), 422, 'validation'],
  ])('%s is a client refusal with a closed reason code', (error, status, reason) => {
    expect(refusalFor(error)).toMatchObject({ status, reason });
  });

  it('any other HealerError is a server fault, not a 422', () => {
    expect(refusalFor(new HealerError('INTERNAL', 'boom'))).toBeNull();
    expect(refusalFor(new HealerError('BUDGET_EXHAUSTED', 'x'))).toBeNull();
    expect(refusalFor(new Error('db down'))).toBeNull();
  });
});
