-- 001 T052 review finding: data-model.md promised an index on `expires_at` that no migration ever
-- created, so every retention run scanned and sorted all of a tenant's evidence. Leads with
-- tenant_id (the tenant-scoped-table rule) and is NOT partial on `ref_state = 'linked'` as the
-- data model first sketched: retention also lists expired *uncited* evidence regardless of
-- ref_state, and a partial index could not serve that branch.
CREATE INDEX "evidence_tenant_id_expires_at_idx" ON "evidence"."evidence"("tenant_id", "expires_at");
