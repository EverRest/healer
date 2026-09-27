-- 001 T026 review finding, reproduced under a real load test: two (or, at worker concurrency 16,
-- up to sixteen) concurrent *first* occurrences of a brand-new fingerprint could each see
-- findOpenByFingerprint return null and each create their own issue — FR-002's "attach to the
-- same open issue" broken exactly at the moment it matters most, a burst of a genuinely new
-- failure. The existing `issue_tenant_id_fingerprint_idx` (non-unique, state NOT IN
-- ('merged','removed')) intentionally stays broad enough to let a resolved issue and its later
-- recurrence share a fingerprint (001 T022) — this index is narrower on purpose: unique, and only
-- over the same "genuinely open" predicate `findOpenByFingerprint` itself queries
-- (state NOT IN ('resolved','merged','removed')), so at most one row can ever be open for a given
-- fingerprint, while resolved/merged/removed history for the same fingerprint is untouched.
CREATE UNIQUE INDEX "issue_tenant_id_fingerprint_open_key" ON "issue"."issue"("tenant_id", "fingerprint")
  WHERE "state" NOT IN ('resolved', 'merged', 'removed');
