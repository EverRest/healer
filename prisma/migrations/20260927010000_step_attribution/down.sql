-- DropTrigger
DROP TRIGGER IF EXISTS evidence_link_step_attribution ON "evidence"."evidence_link";

-- DropFunction
DROP FUNCTION IF EXISTS reject_step_attribution_mismatch();
