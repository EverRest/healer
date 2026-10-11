import { Prisma } from '@healer/prisma-client';
import type { StepKey } from '../domain/request-key.js';

/** SQL over an aliased `policy_decision` that leaves out a replayed step's own earlier decision
 *  (the live allow its request key matches), so a retry is evaluated as if it were the first
 *  attempt while every other decision still counts. Empty when the evaluation is not a step. */
export function excludingStep(alias: string, step: StepKey | undefined): Prisma.Sql {
  if (step === undefined) return Prisma.empty;
  const col = (name: string) => Prisma.raw(`${alias}.${name}`);
  // IS DISTINCT FROM, never `NOT (a = x AND ...)`: a NULL run, state or key makes the latter NULL and
  // would silently drop the row from the counts. NULL means "a different step", so it counts.
  return Prisma.sql`AND (${col('workflow_run_id')}, ${col('workflow_state')}, ${col('request_key')})
    IS DISTINCT FROM (${step.workflowRunId}::uuid, ${step.workflowState}::text, ${step.requestKey}::text)`;
}
