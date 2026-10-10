-- 012 T094 (FR-033, FR-046a, C-34, ADR 0010): an `agent_run` written from a runner's
-- `agent_run_report` says WHERE the call ran, WHICH runner reported it, and HOW MUCH TO TRUST its cost.
--
-- 1. `executed_in` + `runner_instance_id`. The unsafe state — a runner-side run with no runner, or a
--    control-plane run naming one — cannot be stored: `agent_run_runner_iff_runner_instance` is the
--    mechanism that refuses the row. `executed_in` defaults to `control_plane` because every row that
--    exists today was written by a control-plane path (no runner-side writer existed); the default
--    cannot hide a runner row, since a runner row names a `runner_instance_id` and the CHECK then
--    refuses `control_plane`. The FK is RESTRICT: an `agent_run` is the tenant's spend, so deleting a
--    runner registration must not delete or null the cost record (null would also violate the CHECK).
--
-- 2. `cost_provenance`: `reported` = a runner said so and nothing has been reconciled against provider
--    usage (no provider usage source exists yet); `estimated` = a guess, which `check:budget-reconcile`
--    refuses on a finished run. There is deliberately no `measured` value: nothing could write it, and
--    a closed list with a member no writer can produce is a promise with no reader. Adding it is a
--    migration, made in the same change as the reconciliation that earns it.
--    Existing rows backfill to `estimated` — nothing recorded where their cost came from, so the
--    column must not claim better. NO default remains: a writer states its provenance every time.
--
-- 3. `report_id`: the runner-generated idempotency key of one report. A report delivered twice carries
--    the same id and `(tenant_id, report_id)` makes the second a no-op instead of a double charge.
--    Null for rows not written from a report; a runner-side row MUST have one (CHECK).
CREATE TYPE "agent"."executed_in" AS ENUM ('control_plane', 'runner');
CREATE TYPE "agent"."cost_provenance" AS ENUM ('reported', 'estimated');

ALTER TABLE "agent"."agent_run"
  ADD COLUMN "executed_in" "agent"."executed_in" NOT NULL DEFAULT 'control_plane',
  ADD COLUMN "runner_instance_id" UUID,
  ADD COLUMN "cost_provenance" "agent"."cost_provenance" NOT NULL DEFAULT 'estimated',
  ADD COLUMN "report_id" UUID;

ALTER TABLE "agent"."agent_run" ALTER COLUMN "cost_provenance" DROP DEFAULT;

ALTER TABLE "agent"."agent_run"
  ADD CONSTRAINT "agent_run_runner_instance_id_fkey" FOREIGN KEY ("runner_instance_id")
    REFERENCES "runner"."runner_registration"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_run_runner_iff_runner_instance"
    CHECK (("executed_in" = 'runner') = ("runner_instance_id" IS NOT NULL)),
  ADD CONSTRAINT "agent_run_runner_has_report_id"
    CHECK ("executed_in" <> 'runner' OR "report_id" IS NOT NULL);

CREATE UNIQUE INDEX "agent_run_tenant_id_report_id_key" ON "agent"."agent_run"("tenant_id", "report_id");
