-- Reverses 20261008000000: drops the four columns, their constraints and the two enum types.
-- Loses the provenance and runner attribution of rows written since (the cost itself stays).
DROP INDEX IF EXISTS "agent"."agent_run_tenant_id_report_id_key";
ALTER TABLE "agent"."agent_run"
  DROP CONSTRAINT IF EXISTS "agent_run_runner_has_report_id",
  DROP CONSTRAINT IF EXISTS "agent_run_runner_iff_runner_instance",
  DROP CONSTRAINT IF EXISTS "agent_run_runner_instance_id_fkey",
  DROP COLUMN "report_id",
  DROP COLUMN "cost_provenance",
  DROP COLUMN "runner_instance_id",
  DROP COLUMN "executed_in";
DROP TYPE "agent"."cost_provenance";
DROP TYPE "agent"."executed_in";
