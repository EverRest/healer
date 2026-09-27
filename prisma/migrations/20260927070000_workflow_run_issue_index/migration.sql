-- 001 T046 review finding: GetTimeline reaches an issue's machine steps through
-- `workflow_run.issue_id` (workflow_transition has no issue_id of its own). Without this index that
-- join is a scan of every run the tenant has, against plan.md's < 200 ms p95 timeline target.
CREATE INDEX "workflow_run_tenant_id_issue_id_idx" ON "workflow"."workflow_run"("tenant_id", "issue_id");
