-- 001 T053 (FR-018, R-12): the tombstone is the only record that a deletion happened, so the table
-- has to be one nobody can quietly edit, and one that holds identifiers only.
--
-- The table has had no writer until now, so it is empty; the constraints below would refuse to
-- install over a row that broke them.

-- One tombstone per deleted target. Two concurrent deletions are serialised by the issue's row lock
-- and the loser reads the winner's tombstone; this is the second wall for a writer that skips that.
-- tenant_id leads (prisma-migrations.md).
CREATE UNIQUE INDEX "deletion_tombstone_tenant_id_target_type_target_id_key"
  ON "audit"."deletion_tombstone"("tenant_id", "target_type", "target_id");

-- The two free-text fields are the requester's own statement (not derived from what was deleted),
-- and the only place text could be smuggled in. Bounded here as the domain bounds them
-- (`checkDeletionRequest`): a blank requester or reason means a deletion nobody answers for.
ALTER TABLE "audit"."deletion_tombstone"
  ADD CONSTRAINT "deletion_tombstone_requested_by_bounds"
    CHECK (char_length("requested_by") BETWEEN 1 AND 128 AND btrim("requested_by") <> ''),
  ADD CONSTRAINT "deletion_tombstone_reason_bounds"
    CHECK (char_length("reason") BETWEEN 1 AND 500 AND btrim("reason") <> '');

-- Immutable, and unlike the four append-only tables *without* the `healer.privileged_write` bypass:
-- that setting covers every statement of the transaction that turns it on, and the deletion path
-- turns it on. A tombstone that the very path that writes it could rewrite or delete would not be
-- a record that the gap was deliberate (R-12). No path deletes a tombstone; if tenant offboarding
-- ever needs one, it will need its own migration and its own decision.
CREATE OR REPLACE FUNCTION reject_tombstone_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'deletion_tombstone rows are immutable and cannot be % (table: %)',
    lower(TG_OP), TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER deletion_tombstone_immutable
  BEFORE UPDATE OR DELETE ON "audit"."deletion_tombstone"
  FOR EACH ROW EXECUTE FUNCTION reject_tombstone_mutation();

CREATE TRIGGER deletion_tombstone_no_truncate
  BEFORE TRUNCATE ON "audit"."deletion_tombstone"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_tombstone_mutation();
