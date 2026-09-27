-- Producer attribution on evidence_link (001 T007/T008, FR-008, R-06). "Without producer
-- attribution, 'the system concluded X because of Y' is unfalsifiable; with it, a link created by
-- a step other than the one that observed the fact is detectable" (research.md) — enforced here,
-- at the database, the same reasoning and the same shape as the append-only triggers (001 T003):
-- a repository that merely does not accept a step argument is one raw SQL statement away from
-- being wrong.
--
-- `healer.current_step` is set via `set_config('healer.current_step', <step>, true)` — the third
-- argument makes it transaction-local, the same scoping `healer.privileged_write` already uses —
-- by whichever step is actually executing, immediately before the INSERT it is responsible for.
-- No step declared at all is treated the same as a mismatched one: an anonymous write has no
-- attribution to falsify, which is exactly what FR-008 forbids.
CREATE OR REPLACE FUNCTION reject_step_attribution_mismatch() RETURNS trigger AS $$
DECLARE
  executing_step text := current_setting('healer.current_step', true);
BEGIN
  IF executing_step IS NULL OR executing_step = '' THEN
    RAISE EXCEPTION 'STEP_ATTRIBUTION_MISMATCH: no executing step declared for this write (R-06)';
  END IF;
  IF NEW.asserted_by_step IS DISTINCT FROM executing_step THEN
    RAISE EXCEPTION 'STEP_ATTRIBUTION_MISMATCH: link attributed to % but % is executing (R-06)',
      NEW.asserted_by_step, executing_step;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_link_step_attribution
  BEFORE INSERT ON "evidence"."evidence_link"
  FOR EACH ROW EXECUTE FUNCTION reject_step_attribution_mismatch();
