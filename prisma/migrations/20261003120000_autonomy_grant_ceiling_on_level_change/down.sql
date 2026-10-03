DROP TRIGGER autonomy_grant_ceiling_check ON "policy"."autonomy_grant";

CREATE TRIGGER autonomy_grant_ceiling_check
  BEFORE INSERT OR UPDATE ON "policy"."autonomy_grant"
  FOR EACH ROW EXECUTE FUNCTION policy_autonomy_grant_ceiling();
