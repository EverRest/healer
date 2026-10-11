import { Prisma } from '@healer/prisma-client';
import type { StepKey } from '../domain/request-key.js';

/** SQL over an aliased `policy_decision` that leaves out a replayed step's own earlier decision
 *  (the live allow its request key matches), so a retry is evaluated as if it were the first
 *  attempt while every other decision still counts. Empty when the evaluation is not a step. */
export function excludingStep(alias: string, step: StepKey | undefined): Prisma.Sql {
  if (step === undefined) return Prisma.empty;
  const col = (name: string) => Prisma.raw(`${alias}.${name}`);
  return Prisma.sql`AND NOT (${col('workflow_run_id')} = ${step.workflowRunId}::uuid
    AND ${col('workflow_state')} = ${step.workflowState}
    AND ${col('request_key')} = ${step.requestKey})`;
}
