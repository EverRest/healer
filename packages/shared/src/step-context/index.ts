import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The executing step (001 FR-008, R-06). An evidence link carries the step that asserted it; the
 * guarantee is not "remember to pass the right step name" — it's that the writer never accepts one
 * as an argument at all (see `@healer/domain-evidence`'s `NewEvidenceLink`, which has no such
 * field). It reads whichever step is bound to the async context right now, the same way a
 * correlation id threads through `withCorrelation`/`currentCorrelationId`.
 */
export type StepId = string;

const storage = new AsyncLocalStorage<StepId>();

/** Runs `fn` with `stepId` bound as the executing step — the only way to set it. */
export function withStep<T>(stepId: StepId, fn: () => T): T {
  return storage.run(stepId, fn);
}

/** The step executing right now, or undefined outside a step's scope. */
export function currentStep(): StepId | undefined {
  return storage.getStore();
}
