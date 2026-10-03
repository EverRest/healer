-- 002 T035 (FR-008, SC-004, R-05, C-18): `autonomy_grant.level <= ACTION_CEILING(action_class,
-- has_tested_undo)`. Not a plain CHECK constraint — Postgres CHECK constraints cannot reference
-- another table, and the ceiling depends on `policy_action.action_class`, resolved via
-- `autonomy_grant.action_key` — so this is a trigger, the same substitute
-- `reject_policy_decision_mutation` already establishes for a constraint SQL cannot express
-- directly.
--
-- Mirrors `packages/domain/policy/src/domain/ceiling.ts`'s `ACTION_CEILING` exactly for the three
-- classes this repository can attest today: `read_only` → 1, `code_change` → 2,
-- `repository_write` → 2. `reversible_remediation` has no level here (NULL, same as `merge` /
-- `forward_deploy` / `irreversible`) because `hasTestedUndo` has no data source yet — 010's
-- remediation catalogue, the only thing that could attest an undo, does not exist in this
-- repository (same honest-`false` reading `ceiling.ts`'s only two callers already give: `grantAutonomy`
-- and `GET /policy/actions`). This is *more* conservative than `ceiling.ts` for that one class
-- (which permits L5 once `hasTestedUndo` is true) — a dual mechanism does not need to be a
-- textually identical copy, only to never permit *above* the true ceiling (`gate-ceiling`, T038,
-- checks the three classes that can and must agree exactly).
--
-- Respects the same `healer.privileged_write` bypass every other append-only trigger in this
-- database does (`packages/prisma-client/src/privileged-write.ts`) — quickstart 9 exercises this
-- deliberately: a row written through that documented escape hatch still cannot exceed the ceiling
-- at evaluation time (`evaluate()`'s own clamp, already built in T012), which is R-05's whole point.
CREATE OR REPLACE FUNCTION policy_autonomy_grant_ceiling() RETURNS trigger AS $$
DECLARE
  resolved_class "policy"."policy_action_class";
  ceiling_level INTEGER;
BEGIN
  IF current_setting('healer.privileged_write', true) = 'on' THEN
    RETURN NEW;
  END IF;

  SELECT pa.action_class INTO resolved_class
  FROM "policy"."policy_action" pa
  WHERE pa.action_key = NEW.action_key;

  ceiling_level := CASE resolved_class
    WHEN 'read_only' THEN 1
    WHEN 'code_change' THEN 2
    WHEN 'repository_write' THEN 2
    ELSE NULL
  END;

  IF ceiling_level IS NULL OR NEW.level > ceiling_level THEN
    RAISE EXCEPTION 'autonomy_grant.level % exceeds ACTION_CEILING for action_class %',
      NEW.level, resolved_class;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER autonomy_grant_ceiling_check
  BEFORE INSERT OR UPDATE ON "policy"."autonomy_grant"
  FOR EACH ROW EXECUTE FUNCTION policy_autonomy_grant_ceiling();
