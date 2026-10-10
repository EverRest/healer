-- Reverses 20261008000000: drops the four columns, their constraints and indexes, and the two enum types.
-- Loses the provenance and runner attribution of rows written since (the cost itself stays).
-- ROUND-TRIP CAVEAT: down then up is NOT the identity. The up migration backfills every existing row to
-- `cost_provenance = 'estimated'`, so a row that was `reported` before the down comes back `estimated`
-- (and `check:budget-reconcile` then refuses it). Do not round-trip a database holding reported spend.
DROP INDEX IF EXISTS "agent"."agent_run_finished_decision_key";
DROP INDEX IF EXISTS "agent"."agent_run_tenant_id_runner_instance_id_idx";
DROP INDEX IF EXISTS "agent"."agent_run_tenant_id_report_id_key";
ALTER TABLE "agent"."agent_run"
  DROP CONSTRAINT IF EXISTS "agent_run_runner_has_report_id",
  DROP CONSTRAINT IF EXISTS "agent_run_runner_iff_runner_instance",
  DROP CONSTRAINT IF EXISTS "agent_run_tenant_id_runner_instance_id_fkey",
  DROP COLUMN "report_id",
  DROP COLUMN "cost_provenance",
  DROP COLUMN "runner_instance_id",
  DROP COLUMN "executed_in";
DROP INDEX IF EXISTS "runner"."runner_registration_tenant_id_id_key";
DROP TYPE "agent"."cost_provenance";
DROP TYPE "agent"."executed_in";
