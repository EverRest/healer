-- Review of 002 phase 4: `autonomy_grant_ceiling_check` fired on every UPDATE, so revoking
-- (`revoked_by` / `revoked_at` only) re-ran the ceiling check against the current policy_action
-- row. A grant above its ceiling — written through `healer.privileged_write` (quickstart 9) or
-- left behind by a later ceiling change — could therefore not be revoked: the revoke raised
-- "exceeds ACTION_CEILING", no epoch was bumped, and the one row that most needs revoking stayed
-- live. The ceiling constrains `level` and `action_key`; only a change to either re-checks it.
-- The function (and `gate-ceiling`'s drift check of its CASE) is unchanged.
DROP TRIGGER autonomy_grant_ceiling_check ON "policy"."autonomy_grant";

CREATE TRIGGER autonomy_grant_ceiling_check
  BEFORE INSERT OR UPDATE OF level, action_key ON "policy"."autonomy_grant"
  FOR EACH ROW EXECUTE FUNCTION policy_autonomy_grant_ceiling();
